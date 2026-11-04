#!/usr/bin/env bash
# Send one dash0.deployment event to Dash0 over OTLP/HTTP (JSON), so the
# deploy shows as a marker on the service's SLO charts and dashboards.
#
# Portable on purpose: curl only, no Docker, no Dash0 CLI. Call it as the
# LAST step of whatever performs the deploy (a CI job, deploy.sh, terraform
# apply wrapper), once, on success AND on failure, with --status set from the
# outcome. Do not send a separate "started" event.
#
# The marker only appears when service.name, service.namespace and the
# dataset equal what the service's telemetry (and the SLO's spec.service)
# report. A mismatch fails silently, so this script takes them explicitly.
#
# Environment (from the CI secret store, a password manager, or .env):
#   DASH0_OTLP_URL     https://ingress.<region>.aws.dash0.com  (alias: DASH0_OTLP_ENDPOINT)
#   DASH0_AUTH_TOKEN   auth_... with ingest permission          (alias: DASH0_INGEST_TOKEN)
#   DASH0_DATASET      dataset name; default "default"
#
# Usage:
#   scripts/dash0-deployment-event.sh \
#     --service-name slo-demo --service-namespace slo-demo \
#     --service-version v-20260928-1200-abc1234 --environment production \
#     --status succeeded|failed [--deployment-name <pipeline>] [--deployment-id <run id>] \
#     [--vcs-url <repo url>] [--vcs-revision <sha>] [--vcs-ref <branch>] \
#     [--body "Deployed ..."] [--dry-run]
set -euo pipefail

OTLP_URL="${DASH0_OTLP_URL:-${DASH0_OTLP_ENDPOINT:-}}"
AUTH_TOKEN="${DASH0_AUTH_TOKEN:-${DASH0_INGEST_TOKEN:-}}"
DATASET="${DASH0_DATASET:-default}"

SERVICE_NAME="" SERVICE_NAMESPACE="" SERVICE_VERSION="" ENVIRONMENT="" STATUS=""
DEPLOYMENT_NAME="" DEPLOYMENT_ID="" VCS_URL="" VCS_REVISION="" VCS_REF="" BODY="" DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)      SERVICE_NAME="$2"; shift 2 ;;
    --service-namespace) SERVICE_NAMESPACE="$2"; shift 2 ;;
    --service-version)   SERVICE_VERSION="$2"; shift 2 ;;
    --environment)       ENVIRONMENT="$2"; shift 2 ;;
    --status)            STATUS="$2"; shift 2 ;;
    --deployment-name)   DEPLOYMENT_NAME="$2"; shift 2 ;;
    --deployment-id)     DEPLOYMENT_ID="$2"; shift 2 ;;
    --vcs-url)           VCS_URL="$2"; shift 2 ;;
    --vcs-revision)      VCS_REVISION="$2"; shift 2 ;;
    --vcs-ref)           VCS_REF="$2"; shift 2 ;;
    --body)              BODY="$2"; shift 2 ;;
    --dry-run)           DRY_RUN=1; shift ;;
    -h|--help)           sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${SERVICE_NAME}" ]]    || { echo "--service-name is required" >&2; exit 2; }
[[ -n "${SERVICE_VERSION}" ]] || { echo "--service-version is required" >&2; exit 2; }
case "${STATUS}" in
  succeeded|failed) ;;
  *) echo "--status must be 'succeeded' or 'failed' (got '${STATUS}')" >&2; exit 2 ;;
esac
if [[ "${DRY_RUN}" == 0 ]]; then
  [[ -n "${OTLP_URL}" ]]   || { echo "DASH0_OTLP_URL (or DASH0_OTLP_ENDPOINT) is required" >&2; exit 2; }
  [[ -n "${AUTH_TOKEN}" ]] || { echo "DASH0_AUTH_TOKEN (or DASH0_INGEST_TOKEN) is required" >&2; exit 2; }
fi
[[ -n "${BODY}" ]] || BODY="Deployed ${SERVICE_VERSION} (${STATUS})"

# Nanosecond timestamp without GNU date (macOS BSD date has no %N).
now_ns() {
  python3 -c 'import time; print(time.time_ns())' 2>/dev/null \
    || node -e 'console.log(Date.now() + "000000")' 2>/dev/null \
    || echo "$(date +%s)000000000"
}
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
# One OTLP attribute {key, value: {stringValue}}; prints nothing for empty values.
attr() {
  [[ -n "$2" ]] || return 0
  printf '{"key":"%s","value":{"stringValue":"%s"}}' "$1" "$(json_escape "$2")"
}
# Join non-empty attribute JSON fragments with commas.
join_attrs() {
  local out="" a
  for a in "$@"; do
    [[ -n "$a" ]] || continue
    out="${out:+${out},}${a}"
  done
  printf '%s' "$out"
}

TS="$(now_ns)"
RESOURCE_ATTRS="$(join_attrs \
  "$(attr service.name "${SERVICE_NAME}")" \
  "$(attr service.namespace "${SERVICE_NAMESPACE}")" \
  "$(attr service.version "${SERVICE_VERSION}")" \
  "$(attr deployment.environment.name "${ENVIRONMENT}")" \
  "$(attr deployment.name "${DEPLOYMENT_NAME}")" \
  "$(attr deployment.id "${DEPLOYMENT_ID}")")"
LOG_ATTRS="$(join_attrs \
  "$(attr otel.event.name dash0.deployment)" \
  "$(attr deployment.status "${STATUS}")" \
  "$(attr vcs.repository.url.full "${VCS_URL}")" \
  "$(attr vcs.ref.head.revision "${VCS_REVISION}")" \
  "$(attr vcs.ref.head.name "${VCS_REF}")")"

PAYLOAD=$(cat <<JSON
{"resourceLogs":[{"resource":{"attributes":[${RESOURCE_ATTRS}]},"scopeLogs":[{"scope":{"name":"dash0-deployment-event.sh"},"logRecords":[{"timeUnixNano":"${TS}","observedTimeUnixNano":"${TS}","eventName":"dash0.deployment","severityNumber":9,"severityText":"INFO","body":{"stringValue":"$(json_escape "${BODY}")"},"attributes":[${LOG_ATTRS}]}]}]}]}
JSON
)

if [[ "${DRY_RUN}" == 1 ]]; then
  printf '%s\n' "${PAYLOAD}"
  exit 0
fi

HTTP_CODE=$(curl -sS -o /tmp/dash0-deployment-event.$$ -w '%{http_code}' --max-time 20 \
  -X POST "${OTLP_URL%/}/v1/logs" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Dash0-Dataset: ${DATASET}" \
  -H 'Content-Type: application/json' \
  --data "${PAYLOAD}") || { echo "dash0.deployment event: request failed" >&2; rm -f /tmp/dash0-deployment-event.$$; exit 1; }
BODY_OUT=$(cat /tmp/dash0-deployment-event.$$ 2>/dev/null || true); rm -f /tmp/dash0-deployment-event.$$
if [[ "${HTTP_CODE}" =~ ^2 ]]; then
  echo "dash0.deployment event sent: ${SERVICE_NAMESPACE:+${SERVICE_NAMESPACE}/}${SERVICE_NAME} ${SERVICE_VERSION} ${STATUS} (dataset ${DATASET}, HTTP ${HTTP_CODE})"
else
  echo "dash0.deployment event rejected: HTTP ${HTTP_CODE} ${BODY_OUT}" >&2
  exit 1
fi
