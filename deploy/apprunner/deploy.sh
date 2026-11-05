#!/usr/bin/env bash
# Three-phase orchestrator for AWS App Runner:
#   1) CFN infra (VPC, RDS, Redis, ECR, secrets, IAM, VPC connector) - no service yet
#   2) docker build/push, then CFN with CreateService=true (App Runner service)
#   3) CORS + origin patch: CFN pass with CustomDomainParam=<App Runner default
#      domain> and SiteBaseUrlParam=https://<that domain> (or $SITE_BASE_URL)
# Idempotent. Re-run to deploy a new version of the code. When telemetry to
# Dash0 is configured (DASH0_OTLP_URL + DASH0_AUTH_TOKEN, environment first,
# repo .env second), the service is deployed instrumented and every run ends
# by sending one dash0.deployment event, succeeded or failed.
#
# Pre-reqs: working AWS creds (aws sts get-caller-identity succeeds),
# docker daemon running, curl.
# With a 1Password reference in .env:  op run --env-file=.env -- ./deploy/apprunner/deploy.sh

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

# ---------- Dash0 values: environment first, then the repo .env ----------
# The same three values scripts/start-otel.sh reads locally drive the
# deployed workload. Anything already in the environment wins (a CI secret
# store, `op run --env-file=.env --`), so a password-manager reference in
# .env is never read as a literal.
dotenv_value() {
  [[ -f "${REPO_ROOT}/.env" ]] || return 0
  local line; line=$(grep -E "^[[:space:]]*$1=" "${REPO_ROOT}/.env" | tail -1 || true)
  [[ -n "${line}" ]] || return 0
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  # A 1Password secret reference is not the value. Resolve it through the
  # CLI when present (the app prompts for approval), otherwise stop: running
  # with the literal reference would put "op://..." into the OTLP headers.
  if [[ "${line}" == op://* ]]; then
    command -v op >/dev/null \
      || fail "$1 in .env is a 1Password reference; start this script as: op run --env-file=.env -- $0"
    line=$(op read "${line}" 2>/dev/null) \
      || fail "could not resolve $1 from 1Password (approve the prompt, or start as: op run --env-file=.env -- $0)"
  fi
  printf '%s' "${line}"
}
DASH0_OTLP_URL="${DASH0_OTLP_URL:-$(dotenv_value DASH0_OTLP_URL)}"
DASH0_AUTH_TOKEN="${DASH0_AUTH_TOKEN:-$(dotenv_value DASH0_AUTH_TOKEN)}"
DASH0_DATASET="${DASH0_DATASET:-$(dotenv_value DASH0_DATASET)}"
[[ "${DASH0_AUTH_TOKEN}" != op://* ]] \
  || fail "DASH0_AUTH_TOKEN is an unresolved 1Password reference; start as: op run --env-file=.env -- $0"

# ---------- telemetry to Dash0 ----------
# The ingest token goes into ONE Secrets Manager entry holding the complete
# OTLP headers string, mapped to OTEL_EXPORTER_OTLP_HEADERS through App Runner
# RuntimeEnvironmentSecrets. Only the secret's ARN and the (non-secret)
# ingress URL reach CloudFormation. When DASH0_OTLP_URL is unset the params
# are omitted, which keeps the stack's previous values on an update.
OTEL_PARAM=()
if [[ -n "${DASH0_OTLP_URL}" ]]; then
  [[ -n "${DASH0_AUTH_TOKEN}" ]] || fail "DASH0_OTLP_URL is set but DASH0_AUTH_TOKEN is empty"
  case "${DASH0_OTLP_URL}" in
    *api.*) fail "DASH0_OTLP_URL points at the API host (${DASH0_OTLP_URL}); telemetry goes to the ingress host";;
  esac
  OTEL_DATASET="${DASH0_DATASET:-default}"
  OTEL_HEADERS_VALUE="Authorization=Bearer ${DASH0_AUTH_TOKEN},Dash0-Dataset=${OTEL_DATASET}"
  OTEL_HEADERS_SECRET_NAME="${APP_NAME}/otel/otlp-headers"
  OTEL_HEADERS_ARN=$(aws secretsmanager describe-secret \
    --region "${AWS_REGION}" --secret-id "${OTEL_HEADERS_SECRET_NAME}" \
    --query ARN --output text 2>/dev/null || true)
  if [[ -z "${OTEL_HEADERS_ARN}" || "${OTEL_HEADERS_ARN}" == "None" ]]; then
    log "creating OTLP headers secret (${OTEL_HEADERS_SECRET_NAME})"
    OTEL_HEADERS_ARN=$(aws secretsmanager create-secret \
      --region "${AWS_REGION}" --name "${OTEL_HEADERS_SECRET_NAME}" \
      --description "${APP_NAME} Dash0 OTLP headers (Authorization + Dash0-Dataset)" \
      --secret-string "${OTEL_HEADERS_VALUE}" --query ARN --output text) \
      || fail "failed to create ${OTEL_HEADERS_SECRET_NAME}"
  else
    log "updating OTLP headers secret (token/dataset may have changed)"
    aws secretsmanager put-secret-value --region "${AWS_REGION}" \
      --secret-id "${OTEL_HEADERS_SECRET_NAME}" \
      --secret-string "${OTEL_HEADERS_VALUE}" >/dev/null || fail "failed to update ${OTEL_HEADERS_SECRET_NAME}"
  fi
  OTEL_PARAM=(OtelExporterEndpoint="${DASH0_OTLP_URL}" OtelHeadersSecretArn="${OTEL_HEADERS_ARN}")
  # The ingress is an external host: the private subnets need the NAT gateway.
  if [[ "${EXTERNAL_EGRESS}" != "true" ]]; then
    log "telemetry needs external egress: forcing EXTERNAL_EGRESS=true (NAT gateway, ~\$35/month)"
    EXTERNAL_EGRESS=true
  fi
  log "telemetry enabled -> ${DASH0_OTLP_URL} (dataset ${OTEL_DATASET}) as ${APP_NAME}/${APP_NAME} ${VERSION_LABEL}"
else
  log "telemetry disabled (set DASH0_OTLP_URL + DASH0_AUTH_TOKEN, or put them in .env, to enable)"
fi

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
      ${OTEL_PARAM[@]+"${OTEL_PARAM[@]}"} \
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

# ---------- deployment marker (dash0.deployment event) ----------
# One event per deploy, sent from the EXIT trap after the deploy has
# finished, succeeded or failed, so it lands as a marker on the SLO's
# error-budget and burn-rate charts. service.name / service.namespace /
# service.version / dataset are the same variables the workload gets above
# (OTEL_SERVICE_NAME=AppName, service.namespace=AppName, service.version=
# ImageTag); a mismatch means no marker, silently. App Runner blocks until
# the new revision serves traffic, so "after the deploy" is after the CFN
# update returns. Only sent when telemetry is configured; never fatal.
DEPLOY_STARTED=0
DEPLOY_EVENT_SENT=0
send_deploy_event() {
  local status="$1"
  [[ "${DEPLOY_EVENT_SENT}" == 0 ]] || return 0
  DEPLOY_EVENT_SENT=1
  [[ -n "${DASH0_OTLP_URL:-}" && -n "${DASH0_AUTH_TOKEN:-}" ]] || return 0
  local repo_url; repo_url=$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null \
    | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##' || true)
  log "sending dash0.deployment event (${status})"
  DASH0_OTLP_URL="${DASH0_OTLP_URL}" DASH0_AUTH_TOKEN="${DASH0_AUTH_TOKEN}" \
  DASH0_DATASET="${OTEL_DATASET}" \
    "${REPO_ROOT}/scripts/dash0-deployment-event.sh" \
      --service-name "${APP_NAME}" --service-namespace "${APP_NAME}" \
      --service-version "${VERSION_LABEL}" --environment production \
      --status "${status}" \
      --deployment-name apprunner-deploy --deployment-id "${VERSION_LABEL}" \
      --vcs-url "${repo_url}" \
      --vcs-revision "$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)" \
      --vcs-ref "$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" \
    || log "warning: dash0.deployment event not sent (non-fatal)"
}
on_exit() {
  local rc=$?
  if [[ "${DEPLOY_STARTED}" == 1 ]]; then
    if [[ "${rc}" -eq 0 ]]; then send_deploy_event succeeded; else send_deploy_event failed; fi
  fi
  exit "${rc}"
}
trap on_exit EXIT

# ---------- phase 2: App Runner service ----------
log "phase 2/3 - deploying App Runner service (~5 min; CFN waits for RUNNING)"
# SLO demo fault injection: DEMO_FAULT_ERROR_RATE / DEMO_FAULT_LATENCY_RATE /
# DEMO_FAULT_LATENCY_MS in the environment become CFN parameters and reach the
# container as env vars (backend/middleware/demoFault.js). Unset means off, so
# a plain re-run is the "fix" deploy.
if [[ "${DEMO_FAULT_ERROR_RATE:-0}" != 0 || "${DEMO_FAULT_LATENCY_RATE:-0}" != 0 ]]; then
  log "DEMO FAULT ACTIVE for this release: error rate ${DEMO_FAULT_ERROR_RATE:-0}, latency rate ${DEMO_FAULT_LATENCY_RATE:-0} (+${DEMO_FAULT_LATENCY_MS:-900} ms)"
fi
DEPLOY_STARTED=1
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
      ${OTEL_PARAM[@]+"${OTEL_PARAM[@]}"} \
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
