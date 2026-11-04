#!/usr/bin/env bash
# Tears down everything deploy.sh created: the App Runner service, VPC,
# RDS instance, ElastiCache cluster, ECR repo (images purged), and the
# Secrets Manager entries. Destructive - requires an explicit flag.
# The SES sender identity is NOT deleted (it is account-level and may be
# shared with other stacks).

set -euo pipefail

APP_NAME="${APP_NAME:-slo-demo}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
export AWS_PROFILE="${AWS_PROFILE:-DevRel}"
STACK_NAME="${STACK_NAME:-${APP_NAME}-stack}"

log()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m!! %s\033[0m\n" "$*" >&2; exit 1; }

if [[ "${1:-}" != "--yes-delete-everything" ]]; then
  cat >&2 <<EOF
This deletes stack '${STACK_NAME}' in ${AWS_REGION} (profile ${AWS_PROFILE}):

  - the App Runner service (site goes DOWN immediately)
  - the ElastiCache Redis cluster - ALL SESSION/CACHE DATA IS LOST
  - the Secrets Manager entries under ${APP_NAME}/ (purged, no recovery window)
  - the ECR repo including ALL pushed images (EmptyOnDelete)
  - the VPC, subnets, endpoints, and security groups
  - the RDS instance - a FINAL SNAPSHOT IS KEPT (DeletionPolicy: Snapshot),
    everything else about the database is gone

Nothing is deleted until you re-run with the explicit flag:

  ${BASH_SOURCE[0]} --yes-delete-everything
EOF
  exit 1
fi

command -v aws >/dev/null || fail "aws CLI not installed"
aws sts get-caller-identity >/dev/null 2>&1 \
  || fail "aws sts get-caller-identity failed - run: aws sso login --profile ${AWS_PROFILE}"

log "deleting stack ${STACK_NAME} (RDS final snapshot is retained; ~10 min)"
aws cloudformation delete-stack --region "${AWS_REGION}" --stack-name "${STACK_NAME}"
aws cloudformation wait stack-delete-complete --region "${AWS_REGION}" --stack-name "${STACK_NAME}" \
  || fail "stack deletion did not complete - check the CloudFormation console for the blocking resource"

# CloudFormation deletes secrets with the default 30-day recovery window,
# which blocks re-creating a stack with the same AppName until the window
# expires. Purge them so the name is immediately reusable. A secret already
# scheduled for deletion rejects delete-secret, so restore it first (no-op
# when it isn't scheduled).
log "purging Secrets Manager entries under ${APP_NAME}/ (skips any that are already gone)"
for s in db/name db/user db/password db/host db/port app/session-secret otel/otlp-headers; do
  aws secretsmanager restore-secret \
    --region "${AWS_REGION}" \
    --secret-id "${APP_NAME}/${s}" >/dev/null 2>&1 || true
  aws secretsmanager delete-secret \
    --region "${AWS_REGION}" \
    --secret-id "${APP_NAME}/${s}" \
    --force-delete-without-recovery >/dev/null 2>&1 || true
done

log "teardown complete. The RDS final snapshot (${APP_NAME}-db-*) still incurs storage cost;"
log "list it with: aws rds describe-db-snapshots --region ${AWS_REGION} --query 'DBSnapshots[?starts_with(DBSnapshotIdentifier, \`${APP_NAME}\`)].DBSnapshotIdentifier'"
