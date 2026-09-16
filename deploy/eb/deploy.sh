#!/usr/bin/env bash
# Two-phase orchestrator: CFN infra → ECR image → CFN environment.
# Idempotent. Re-run to deploy a new version of the code.
#
# Pre-reqs: working AWS creds (aws sts get-caller-identity succeeds),
# docker running, openssl, zip.

set -euo pipefail

APP_NAME="${APP_NAME:-devopser-demo}"
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-${APP_NAME}-stack}"
# AWS Partner Revenue Measurement code; every resource gets aws-apn-id=pc:<code>.
DEVOPSER_APN_PRODUCT_CODE="${DEVOPSER_APN_PRODUCT_CODE:-6ydf4kme1p7fqu1vp1wy1uxoc}"
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${TEMPLATE_DIR}/../.." && pwd)"

log()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m!! %s\033[0m\n" "$*" >&2; exit 1; }

# ---------- sanity ----------
command -v aws    >/dev/null || fail "aws CLI not installed"
command -v docker >/dev/null || fail "docker not installed"
command -v zip    >/dev/null || fail "zip not installed"
command -v openssl>/dev/null || fail "openssl not installed"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "aws sts get-caller-identity failed — export fresh credentials first"
log "account: ${ACCOUNT_ID} region: ${AWS_REGION}"

BUNDLE_BUCKET="${APP_NAME}-eb-bundles-${ACCOUNT_ID}-${AWS_REGION}"
VERSION_LABEL="v-$(date +%Y%m%d-%H%M%S)-$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"
BUNDLE_KEY="bundles/${VERSION_LABEL}.zip"

# ---------- phase 1: infra (CFN without EB env) ----------
# Stash generated secrets in a local file so re-runs reuse the same password
# (rotating DBPasswordParam would force an RDS master-password update on every run).
PARAMS_CACHE="${TEMPLATE_DIR}/.params.local"
if [[ ! -f "${PARAMS_CACHE}" ]]; then
  DB_PW=$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)
  SESS_SECRET=$(openssl rand -hex 32)
  cat > "${PARAMS_CACHE}" <<EOF
DBPasswordParam=${DB_PW}
SessionSecretParam=${SESS_SECRET}
EOF
  chmod 600 "${PARAMS_CACHE}"
  log "generated secrets cached to ${PARAMS_CACHE} (git-ignored)"
fi
# shellcheck disable=SC2046
set -a; source "${PARAMS_CACHE}"; set +a

log "phase 1/2 — deploying infra (CFN, no EB env yet)"
aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_DIR}/cloudformation.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AppName="${APP_NAME}" \
      CreateEBEnvironment=false \
      DBPasswordParam="${DBPasswordParam}" \
      SessionSecretParam="${SessionSecretParam}" \
      DevOpserApnProductCode="${DEVOPSER_APN_PRODUCT_CODE}" \
  --tags aws-apn-id="pc:${DEVOPSER_APN_PRODUCT_CODE}" \
  --no-fail-on-empty-changeset

ECR_URI=$(aws cloudformation describe-stacks \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='EcrRepoUri'].OutputValue" \
  --output text)
[[ -n "${ECR_URI}" ]] || fail "failed to read EcrRepoUri from stack outputs"
log "ECR repo: ${ECR_URI}"

# ---------- build & push image ----------
log "building template base image"
docker build \
  --platform linux/amd64 \
  -t devopser-template-base:latest \
  -f "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}"

log "building EB wrapper image"
docker build \
  --platform linux/amd64 \
  --build-arg BASE_IMAGE=devopser-template-base:latest \
  -t "${ECR_URI}:${VERSION_LABEL}" \
  -t "${ECR_URI}:latest" \
  -f "${TEMPLATE_DIR}/Dockerfile.eb" \
  "${REPO_ROOT}"

log "logging in to ECR"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"

log "pushing image ${VERSION_LABEL}"
docker push "${ECR_URI}:${VERSION_LABEL}"
docker push "${ECR_URI}:latest"

# ---------- package bundle ----------
log "packaging Dockerrun.aws.json bundle"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
sed "s|__IMAGE_URI__|${ECR_URI}:${VERSION_LABEL}|" \
  "${TEMPLATE_DIR}/Dockerrun.aws.json.template" \
  > "${WORK}/Dockerrun.aws.json"
( cd "${WORK}" && zip -q bundle.zip Dockerrun.aws.json )

log "ensuring bundle bucket exists: ${BUNDLE_BUCKET}"
if ! aws s3api head-bucket --bucket "${BUNDLE_BUCKET}" 2>/dev/null; then
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${BUNDLE_BUCKET}" --region "${AWS_REGION}"
  else
    aws s3api create-bucket --bucket "${BUNDLE_BUCKET}" --region "${AWS_REGION}" \
      --create-bucket-configuration LocationConstraint="${AWS_REGION}"
  fi
  aws s3api put-bucket-encryption --bucket "${BUNDLE_BUCKET}" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "${BUNDLE_BUCKET}" \
    --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
fi

log "uploading bundle to s3://${BUNDLE_BUCKET}/${BUNDLE_KEY}"
aws s3 cp "${WORK}/bundle.zip" "s3://${BUNDLE_BUCKET}/${BUNDLE_KEY}" --only-show-errors

# ---------- phase 2: EB env ----------
log "phase 2/2 — deploying EB environment (this takes ~5–10 min on first run)"
aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_DIR}/cloudformation.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      AppName="${APP_NAME}" \
      CreateEBEnvironment=true \
      DBPasswordParam="${DBPasswordParam}" \
      SessionSecretParam="${SessionSecretParam}" \
      SourceBundleBucket="${BUNDLE_BUCKET}" \
      SourceBundleKey="${BUNDLE_KEY}" \
      VersionLabel="${VERSION_LABEL}" \
      DevOpserApnProductCode="${DEVOPSER_APN_PRODUCT_CODE}" \
  --tags aws-apn-id="pc:${DEVOPSER_APN_PRODUCT_CODE}" \
  --no-fail-on-empty-changeset

EB_URL=$(aws cloudformation describe-stacks \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='EbEnvironmentURL'].OutputValue" \
  --output text)

# ---------- CORS allowlist: register the EB CNAME ----------
# backend/server.js uses a default-deny CORS middleware. Without this step,
# the first browser request to /api/preview/generate returns 500 with
# "Not allowed by CORS" in the container logs — it looks like the LLM is
# broken but the request never reaches the LLM layer. AGENTS.md > "CORS for
# deployed environments" explains the contract.
EB_CNAME=$(aws elasticbeanstalk describe-environments \
  --region "${AWS_REGION}" \
  --application-name "${APP_NAME}" \
  --environment-names "${APP_NAME}-env" \
  --query 'Environments[0].CNAME' \
  --output text 2>/dev/null || echo "")

if [[ -n "${EB_CNAME}" && "${EB_CNAME}" != "None" ]]; then
  log "registering ${EB_CNAME} in CUSTOM_DOMAIN for CORS"
  aws elasticbeanstalk update-environment \
    --region "${AWS_REGION}" \
    --environment-name "${APP_NAME}-env" \
    --option-settings "Namespace=aws:elasticbeanstalk:application:environment,OptionName=CUSTOM_DOMAIN,Value=${EB_CNAME}" \
    --query 'Status' --output text >/dev/null
  aws elasticbeanstalk wait environment-updated \
    --region "${AWS_REGION}" \
    --environment-name "${APP_NAME}-env" \
    || log "warning: environment-updated wait failed (creds may have expired); check CUSTOM_DOMAIN in EB console"
fi

cat <<EOF

==========================================================================
Deploy complete.

  EB URL:      ${EB_URL}
  Version:     ${VERSION_LABEL}
  Stack:       ${STACK_NAME}

Verify:
  curl -sS -o /dev/null -w '%{http_code}\\n' ${EB_URL}/health
  curl -sS -o /dev/null -w '%{http_code}\\n' ${EB_URL}/auth/login

Admin login: admin@example.com / adminpass (change on first login)
==========================================================================
EOF
