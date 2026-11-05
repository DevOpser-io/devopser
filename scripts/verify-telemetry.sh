#!/usr/bin/env bash
# Generate traffic against a running instance and prove, from the terminal,
# that its telemetry arrived in Dash0.
#
# Sends REQUESTS requests (default 20) to BASE_URL (default the local dev
# server), including at least one that fails with a 5xx, waits for the SDK's
# export interval, then asks the Prometheus-compatible API on the API host
# how many SERVER spans it stored for this service, by status code.
#
# Environment (environment first, repo .env second; the environment wins):
#   DASH0_API_URL      https://api.<region>.aws.dash0.com   (API host, not the ingress)
#   DASH0_AUTH_TOKEN   auth_...  (any permission that can read the dataset)
#   DASH0_DATASET      dataset id; default "default"
#   BASE_URL           default http://localhost:8000
#   REQUESTS           default 20
#   ENVIRONMENT        deployment.environment.name to query; default local
#
# With a 1Password reference in .env:  op run --env-file=.env -- ./scripts/verify-telemetry.sh
#
# The failure route: POST /api/preview/generate (public, no login) answers
# 500 when the LLM dependency is unreachable, which is how a laptop without
# AWS credentials behaves (start the app with AWS_PROFILE=<nonexistent> to
# force it). A 404 or a 401 would not count: only a 5xx or an unhandled
# exception makes the HTTP instrumentation set status ERROR on the server span.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load .env without clobbering values already in the environment.
if [[ -f "${ROOT}/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# || -z "${line//[[:space:]]/}" ]] && continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [[ -n "${!key:-}" ]] || export "$key=$val"
  done < "${ROOT}/.env"
fi
TOKEN="${DASH0_AUTH_TOKEN:-}"
if [[ -z "${TOKEN}" || "${TOKEN}" == op://* ]]; then
  echo "DASH0_AUTH_TOKEN is empty or an unresolved 1Password reference; start as: op run --env-file=.env -- $0" >&2
  exit 2
fi
: "${DASH0_API_URL:?set DASH0_API_URL, e.g. https://api.<region>.aws.dash0.com}"
case "${DASH0_API_URL}" in
  *ingress.*) echo "DASH0_API_URL points at the ingress host; queries go to the API host (api.<region>...)" >&2; exit 2 ;;
esac
DATASET="${DASH0_DATASET:-default}"
BASE_URL="${BASE_URL:-http://localhost:8000}"
REQUESTS="${REQUESTS:-20}"
ENVIRONMENT="${ENVIRONMENT:-local}"
# REQUIRE_FAILURE=0 skips the 5xx checks (production, where failing on purpose is not wanted).
REQUIRE_FAILURE="${REQUIRE_FAILURE:-1}"
SERVICE_NAME="${OTEL_SERVICE_NAME:-slo-demo}"
SERVICE_NAMESPACE="${SERVICE_NAMESPACE:-slo-demo}"

# ---------- traffic ----------
echo "==> ${REQUESTS} requests to ${BASE_URL} (at least one 5xx)"
declare -a CODES=()
hit() { local label="$1"; shift; CODES+=("${label} $(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 "$@" 2>/dev/null || echo 000)"); }
ok_routes=(/health / /auth/login /api/health)
sent=0
# Two deliberate failures: POST /api/preview/generate answers 500 when the
# LLM dependency is unreachable.
for _ in 1 2; do
  hit "POST /api/preview/generate" -X POST "${BASE_URL}/api/preview/generate" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE_URL}" \
    --data '{"prompt":"A telemetry verification request from scripts/verify-telemetry.sh"}'
  sent=$((sent + 1))
done
i=0
while [[ ${sent} -lt ${REQUESTS} ]]; do
  route="${ok_routes[$((i % ${#ok_routes[@]}))]}"
  hit "GET ${route}" "${BASE_URL}${route}"
  sent=$((sent + 1)); i=$((i + 1))
done
printf '%s\n' "${CODES[@]}" | sort | uniq -c | sed 's/^/    /'
fails=$(printf '%s\n' "${CODES[@]}" | grep -c ' 5[0-9][0-9]$' || true)
if [[ "${REQUIRE_FAILURE}" == 1 ]]; then
  [[ "${fails}" -gt 0 ]] || { echo "!! no request returned 5xx; the failure route did not fail" >&2; exit 1; }
  echo "    failure route: POST /api/preview/generate (${fails}x 5xx)"
fi

# ---------- wait for the export interval ----------
# Traces export within ~5 s, metrics on the 60 s periodic reader, and Dash0
# needs a moment to index. Poll instead of a fixed sleep.
QUERY="sum by (otel_span_status_code) (increase({otel_metric_name=\"dash0.spans\", service_namespace=\"${SERVICE_NAMESPACE}\", service_name=\"${SERVICE_NAME}\", deployment_environment_name=\"${ENVIRONMENT}\", otel_span_kind=\"SERVER\"}[30m]))"
echo "==> querying ${DASH0_API_URL} (dataset ${DATASET}) for SERVER spans of ${SERVICE_NAMESPACE}/${SERVICE_NAME} in ${ENVIRONMENT}"
for attempt in $(seq 1 12); do
  sleep 10
  RESP=$(curl -sS --max-time 20 "${DASH0_API_URL%/}/api/prometheus/api/v1/query" \
    -H "Authorization: Bearer ${TOKEN}" -H "Dash0-Dataset: ${DATASET}" \
    --data-urlencode "query=${QUERY}") || { echo "!! query request failed" >&2; exit 1; }
  if printf '%s' "${RESP}" | grep -q '"status":"error"'; then
    echo "!! API error: ${RESP}" >&2; exit 1
  fi
  if printf '%s' "${RESP}" | grep -q '"otel_span_status_code"'; then
    break
  fi
  echo "    attempt ${attempt}: nothing yet"
done
REQUIRE_FAILURE="${REQUIRE_FAILURE}" printf '%s\n' "${RESP}" | python3 -c '
import json, sys, os
d = json.load(sys.stdin)
rows = d.get("data", {}).get("result", [])
if not rows:
    print("!! no SERVER spans found for this service in the last 30 minutes"); sys.exit(1)
for r in rows:
    code = r["metric"].get("otel_span_status_code", "(unset)")
    print("    otel_span_status_code=%-8s spans=%.0f" % (code, float(r["value"][1])))
if os.environ.get("REQUIRE_FAILURE", "1") == "1" and not any(r["metric"].get("otel_span_status_code") == "ERROR" for r in rows):
    print("!! no ERROR span arrived yet (the failure may still be in flight; re-run in a minute)"); sys.exit(1)
print("    OK: spans arrived" + (", including the ERROR span" if os.environ.get("REQUIRE_FAILURE", "1") == "1" else ""))
'
