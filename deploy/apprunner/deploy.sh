#!/usr/bin/env bash
# Three-phase orchestrator for AWS App Runner:
#   1) CFN infra (VPC, RDS, Redis, ECR, secrets, IAM, VPC connector) - no service yet
#   2) docker build/push, then CFN with CreateService=true (App Runner service)
#   3) CORS + origin patch: CFN pass with CustomDomainParam=<App Runner default
#      domain> and SiteBaseUrlParam=https://<that domain> (or $SITE_BASE_URL)
# Idempotent. Re-run to deploy a new version of the code.
#
# Pre-reqs: working AWS creds (aws sts get-caller-identity succeeds),
# docker daemon running, curl.

set -euo pipefail

APP_NAME="${APP_NAME:-slo-demo}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
export AWS_PROFILE="${AWS_PROFILE:-DevRel}"
STACK_NAME="${STACK_NAME:-${APP_NAME}-stack}"
BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-eu.anthropic.claude-sonnet-4-6}"
EXTERNAL_EGRESS="${EXTERNAL_EGRESS:-false}"
# AWS Partner Revenue Measurement code; the stack (and every taggable
# resource in it) gets aws-apn-id=pc:<code>. Same code as deploy/eb.
DEVOPSER_APN_PRODUCT_CODE="${DEVOPSER_APN_PRODUCT_CODE:-6ydf4kme1p7fqu1vp1wy1uxoc}"
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${TEMPLATE_DIR}/../.." && pwd)"

log()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m!! %s\033[0m\n" "$*" >&2; exit 1; }

# ---------- sanity ----------
command -v aws     >/dev/null || fail "aws CLI not installed"
command -v docker  >/dev/null || fail "docker not installed"
command -v curl    >/dev/null || fail "curl not installed"
docker info >/dev/null 2>&1   || fail "docker daemon not running - start Docker Desktop first"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "aws sts get-caller-identity failed - run: aws sso login --profile ${AWS_PROFILE}"
log "account: ${ACCOUNT_ID} region: ${AWS_REGION} profile: ${AWS_PROFILE}"

VERSION_LABEL="v-$(date +%Y%m%d-%H%M%S)-$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"

stack_output() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text 2>/dev/null || true
}

stack_param() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" \
    --output text 2>/dev/null || true
}

# ---------- SES sender identity (outside CloudFormation) ----------
# Sign-in is by emailed link only, so the service needs a verified SES
# sender or nobody can log in. The identity is created here rather than in
# the template so that an address already verified for another stack (or by
# hand) never causes an "already exists" failure. Idempotent. SES emails a
# verification link to the address on first create; delivery works only
# after that click. Only passed to CFN when set: omitted parameters keep
# their previous stack value, so a re-run without the env var doesn't
# silently disable email.
SES_PARAM=()
if [[ -n "${SES_FROM_EMAIL:-}" ]]; then
  SES_STATUS=$(aws sesv2 get-email-identity --region "${AWS_REGION}" \
    --email-identity "${SES_FROM_EMAIL}" \
    --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo MISSING)
  if [[ "${SES_STATUS}" == "MISSING" ]]; then
    log "creating SES sender identity ${SES_FROM_EMAIL} (check that inbox for the verification link)"
    aws sesv2 create-email-identity --region "${AWS_REGION}" \
      --email-identity "${SES_FROM_EMAIL}" >/dev/null \
      || fail "failed to create SES identity ${SES_FROM_EMAIL}"
  elif [[ "${SES_STATUS}" == "True" ]]; then
    log "SES sender ${SES_FROM_EMAIL} is verified"
  else
    log "SES sender ${SES_FROM_EMAIL} exists but is NOT verified yet - click the link SES emailed to it"
  fi
  SES_PARAM=(SesFromEmail="${SES_FROM_EMAIL}")
else
  log "SES_FROM_EMAIL not set - email stays as previously configured (disabled on a first deploy)"
fi

# ---------- phase 1: infra (CFN without the App Runner service) ----------
# The session signing secret and the RDS master password are generated
# in-stack by Secrets Manager - no secret material passes through this
# script or CFN parameters.
#
# CreateService / ImageTag / CustomDomainParam / SiteBaseUrlParam are
# intentionally NOT passed here: on stack UPDATES `cloudformation deploy`
# keeps each omitted parameter's previous value, and on the first CREATE the
# template defaults apply (CreateService=false). Re-runs therefore never
# tear the running service down during phase 1.
log "phase 1/3 - deploying infra (CFN; ~15 min on first run, RDS is the long pole)"
aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_DIR}/cloudformation.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AppName="${APP_NAME}" \
      BedrockModelId="${BEDROCK_MODEL_ID}" \
      ExternalEgress="${EXTERNAL_EGRESS}" \
      ${SES_PARAM[@]+"${SES_PARAM[@]}"} \
  --tags aws-apn-id="pc:${DEVOPSER_APN_PRODUCT_CODE}" \
  --no-fail-on-empty-changeset

ECR_URI=$(stack_output EcrRepoUri)
[[ -n "${ECR_URI}" && "${ECR_URI}" != "None" ]] || fail "failed to read EcrRepoUri from stack outputs"
log "ECR repo: ${ECR_URI}"

# ---------- build & push image ----------
# App Runner runs x86_64 containers only (AWS::AppRunner::Service exposes no
# CPU-architecture setting), so the build targets linux/amd64 explicitly -
# on Apple Silicon this cross-builds under emulation.
log "building template base image (linux/amd64)"
docker build \
  --platform linux/amd64 \
  -t "${APP_NAME}-base:latest" \
  -f "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}"

log "building App Runner wrapper image (adds awscli + migration entrypoint)"
docker build \
  --platform linux/amd64 \
  --build-arg BASE_IMAGE="${APP_NAME}-base:latest" \
  -t "${ECR_URI}:${VERSION_LABEL}" \
  -t "${ECR_URI}:latest" \
  -f "${TEMPLATE_DIR}/Dockerfile.apprunner" \
  "${REPO_ROOT}"

log "logging in to ECR"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"

log "pushing image ${VERSION_LABEL}"
docker push "${ECR_URI}:${VERSION_LABEL}"
docker push "${ECR_URI}:latest"


# ---------- phase 2: App Runner service ----------
log "phase 2/3 - deploying App Runner service (~5 min; CFN waits for RUNNING)"
# SLO demo fault injection: DEMO_FAULT_ERROR_RATE / DEMO_FAULT_LATENCY_RATE /
# DEMO_FAULT_LATENCY_MS in the environment become CFN parameters and reach the
# container as env vars (backend/middleware/demoFault.js). Unset means off, so
# a plain re-run is the "fix" deploy.
if [[ "${DEMO_FAULT_ERROR_RATE:-0}" != 0 || "${DEMO_FAULT_LATENCY_RATE:-0}" != 0 ]]; then
  log "DEMO FAULT ACTIVE for this release: error rate ${DEMO_FAULT_ERROR_RATE:-0}, latency rate ${DEMO_FAULT_LATENCY_RATE:-0} (+${DEMO_FAULT_LATENCY_MS:-900} ms)"
fi
aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_DIR}/cloudformation.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AppName="${APP_NAME}" \
      BedrockModelId="${BEDROCK_MODEL_ID}" \
      ExternalEgress="${EXTERNAL_EGRESS}" \
      ${SES_PARAM[@]+"${SES_PARAM[@]}"} \
      CreateService=true \
      ImageTag="${VERSION_LABEL}" \
      DemoFaultErrorRate="${DEMO_FAULT_ERROR_RATE:-0}" \
      DemoFaultLatencyRate="${DEMO_FAULT_LATENCY_RATE:-0}" \
      DemoFaultLatencyMs="${DEMO_FAULT_LATENCY_MS:-900}" \
  --tags aws-apn-id="pc:${DEVOPSER_APN_PRODUCT_CODE}" \
  --no-fail-on-empty-changeset

SERVICE_URL=$(stack_output ServiceUrl)
SERVICE_ARN=$(stack_output ServiceArn)
[[ -n "${SERVICE_URL}" && "${SERVICE_URL}" != "None" ]] || fail "failed to read ServiceUrl from stack outputs"
[[ -n "${SERVICE_ARN}" && "${SERVICE_ARN}" != "None" ]] || fail "failed to read ServiceArn from stack outputs"
SERVICE_ID="${SERVICE_ARN##*/}"
LOG_HINT="aws logs tail \"/aws/apprunner/${APP_NAME}/${SERVICE_ID}/application\" --region ${AWS_REGION} --follow"

# ---------- phase 3: CORS allowlist - register the App Runner domain ----------
# backend/server.js uses a default-deny CORS middleware. Without this step,
# the first browser request to /api/preview/generate returns 500 with
# "Not allowed by CORS" in the container logs - it looks like the LLM is
# broken but the request never reaches the LLM layer. AGENTS.md > "CORS for
# deployed environments" mandates patching the hostname in automatically.
# The default domain only exists after the service is provisioned, so a
# same-template self-reference is impossible; instead we re-deploy with the
# CustomDomainParam parameter set. `cloudformation deploy` blocks until the
# App Runner update deployment finishes, which satisfies the "wait for the
# rollout before printing success" contract.
#
# CUSTOM_DOMAIN is a comma-separated allowlist and users are told to APPEND
# custom hostnames to it (README.md > "Not covered", AGENTS.md: "in addition
# to, not instead of"), so this pass must merge, never overwrite: skip when
# SERVICE_URL is already one of the entries, otherwise append it to whatever
# is there. The membership test strips spaces because backend/server.js
# trims each entry too.
#
# The same pass sets SITE_BASE_URL: the ONE canonical public origin the app
# bakes into emailed sign-in links and the Google OAuth callback
# (backend/routes/auth.js canonicalBaseUrl(); request headers are never
# trusted). Defaults to the App Runner domain; override with
# SITE_BASE_URL=https://your.custom.domain once a custom domain is attached.
CURRENT_CUSTOM_DOMAIN=$(stack_param CustomDomainParam)
[[ "${CURRENT_CUSTOM_DOMAIN}" == "None" ]] && CURRENT_CUSTOM_DOMAIN=""
WANT_SITE_BASE_URL="${SITE_BASE_URL:-https://${SERVICE_URL}}"
CURRENT_SITE_BASE_URL=$(stack_param SiteBaseUrlParam)
[[ "${CURRENT_SITE_BASE_URL}" == "None" ]] && CURRENT_SITE_BASE_URL=""
if [[ ",${CURRENT_CUSTOM_DOMAIN// /}," == *",${SERVICE_URL},"* ]]; then
  NEW_CUSTOM_DOMAIN="${CURRENT_CUSTOM_DOMAIN}"
else
  NEW_CUSTOM_DOMAIN="${CURRENT_CUSTOM_DOMAIN:+${CURRENT_CUSTOM_DOMAIN},}${SERVICE_URL}"
fi
if [[ "${NEW_CUSTOM_DOMAIN}" == "${CURRENT_CUSTOM_DOMAIN}" && "${WANT_SITE_BASE_URL}" == "${CURRENT_SITE_BASE_URL}" ]]; then
  log "phase 3/3 - CUSTOM_DOMAIN already contains ${SERVICE_URL} and SITE_BASE_URL=${WANT_SITE_BASE_URL}, skipping"
else
  log "phase 3/3 - registering ${SERVICE_URL} in CUSTOM_DOMAIN (CORS) + SITE_BASE_URL=${WANT_SITE_BASE_URL} (~3 min rollout)"
  aws cloudformation deploy \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --template-file "${TEMPLATE_DIR}/cloudformation.yaml" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        CustomDomainParam="${NEW_CUSTOM_DOMAIN}" \
        SiteBaseUrlParam="${WANT_SITE_BASE_URL}" \
    --tags aws-apn-id="pc:${DEVOPSER_APN_PRODUCT_CODE}" \
    --no-fail-on-empty-changeset
fi

# ---------- wait for RUNNING + health verification gate ----------
# There is no `aws apprunner wait` waiter; CFN already blocked until the
# rollout finished, so this poll is a cheap belt-and-braces check.
log "waiting for service status RUNNING"
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$(aws apprunner describe-service \
    --region "${AWS_REGION}" \
    --service-arn "${SERVICE_ARN}" \
    --query Service.Status --output text 2>/dev/null || echo UNKNOWN)
  [[ "${STATUS}" == "RUNNING" ]] && break
  [[ "${STATUS}" == "CREATE_FAILED" || "${STATUS}" == "DELETE_FAILED" ]] \
    && fail "service entered ${STATUS} - inspect logs: ${LOG_HINT}"
  sleep 10
done
[[ "${STATUS}" == "RUNNING" ]] || fail "service never reached RUNNING (last: ${STATUS}) - inspect logs: ${LOG_HINT}"

log "verification gate: GET https://${SERVICE_URL}/health must return 200"
HEALTH_CODE=000
for _ in $(seq 1 30); do
  HEALTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "https://${SERVICE_URL}/health" 2>/dev/null || echo 000)
  [[ "${HEALTH_CODE}" == "200" ]] && break
  sleep 10
done
[[ "${HEALTH_CODE}" == "200" ]] \
  || fail "health check returned ${HEALTH_CODE}, expected 200 - inspect logs: ${LOG_HINT}"

EMAIL_NOTE="Sign-in is by emailed link only (no password form). Re-run with
SES_FROM_EMAIL=<sender> to enable it; nobody can log in until that is in place."
if [[ -n "${SES_FROM_EMAIL:-}" ]]; then
  SES_STATUS=$(aws sesv2 get-email-identity --region "${AWS_REGION}" \
    --email-identity "${SES_FROM_EMAIL}" \
    --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo False)
  if [[ "${SES_STATUS}" == "True" ]]; then
    EMAIL_NOTE="Sign-in emails are sent from ${SES_FROM_EMAIL} (verified)."
  else
    EMAIL_NOTE="Sign-in emails will be sent from ${SES_FROM_EMAIL}, which is NOT verified yet.
Click the verification link SES emailed to that address; until then no sign-in
email can be delivered."
  fi
fi

cat <<EOF

==========================================================================
Deploy complete.

  URL:         https://${SERVICE_URL}
  Version:     ${VERSION_LABEL}
  Stack:       ${STACK_NAME}
  Service:     ${SERVICE_ARN}

Verify:
  curl -sS -o /dev/null -w '%{http_code}\\n' https://${SERVICE_URL}/health
  curl -sS -o /dev/null -w '%{http_code}\\n' https://${SERVICE_URL}/auth/login

Logs:
  ${LOG_HINT}

${EMAIL_NOTE}
==========================================================================
EOF
