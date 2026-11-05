#!/usr/bin/env bash
# Apply (create or update) the SLO definitions under slo/ to Dash0.
#
# Idempotent: each file is PUT to /api/slos/<dash0.com/origin>?dataset=...,
# which creates the SLO on first run and updates it afterwards. Needs an auth
# token with ALL permissions (an ingest-only token gets 403).
#
# Environment (from .env, a password manager via `op run --env-file=.env --`,
# or the CI secret store; the environment wins over .env):
#   DASH0_API_URL       https://api.<region>.aws.dash0.com   (the API host, not the ingress; alias DASH0_API_ENDPOINT)
#   DASH0_API_TOKEN     auth_... with ALL permissions (falls back to DASH0_AUTH_TOKEN when there is one token)
#   DASH0_DATASET       dataset id; default "default" (demo datasets cannot hold SLOs)
#
# Usage: scripts/apply-slo.sh [--dry-run] [file.slo.yaml ...]
#   --dry-run  print the JSON that would be sent and exit
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
DASH0_API_URL="${DASH0_API_URL:-${DASH0_API_ENDPOINT:-}}"
API_TOKEN="${DASH0_API_TOKEN:-${DASH0_AUTH_TOKEN:-}}"
# A password-manager reference is not the token: resolve it via the CLI or stop.
if [[ "${API_TOKEN}" == op://* ]]; then
  if command -v op >/dev/null 2>&1; then
    API_TOKEN="$(op read "${API_TOKEN}")" || { echo "could not resolve the token from 1Password; start as: op run --env-file=.env -- $0" >&2; exit 2; }
  else
    echo "DASH0_API_TOKEN / DASH0_AUTH_TOKEN is a 1Password reference; start as: op run --env-file=.env -- $0" >&2; exit 2
  fi
fi

DRY_RUN=0
FILES=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) FILES+=("$arg") ;;
  esac
done
[[ ${#FILES[@]} -gt 0 ]] || FILES=("${ROOT}"/slo/*.slo.yaml)

DATASET="${DASH0_DATASET:-default}"
if [[ "${DRY_RUN}" == 0 ]]; then
  : "${DASH0_API_URL:?set DASH0_API_URL, e.g. https://api.eu-west-1.aws.dash0.com}"
  [[ -n "${API_TOKEN}" ]] || { echo "set DASH0_API_TOKEN (all permissions; DASH0_AUTH_TOKEN also works)" >&2; exit 2; }
  case "${DASH0_API_URL}" in
    *ingress.*) echo "DASH0_API_URL points at the ingress host; SLOs go to the API host (api.<region>...)" >&2; exit 2 ;;
  esac
fi

to_json() {
  if command -v yq >/dev/null 2>&1; then
    yq -o=json -I=0 '.' "$1"
  elif python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 -c 'import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))' "$1"
  else
    echo "need yq or python3 with PyYAML to convert YAML to JSON (brew install yq | pip install pyyaml)" >&2
    exit 2
  fi
}

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "no such file: $f" >&2; exit 2; }
  json="$(to_json "$f")"
  origin="$(printf '%s' "$json" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const o=d.metadata&&d.metadata.labels&&d.metadata.labels["dash0.com/origin"];if(!o){console.error("metadata.labels[dash0.com/origin] missing");process.exit(2)}console.log(o)')"
  if [[ "${DRY_RUN}" == 1 ]]; then
    echo "# ${f} -> PUT ${DASH0_API_URL:-<DASH0_API_URL>}/api/slos/${origin}?dataset=${DATASET}"
    printf '%s\n' "$json"
    continue
  fi
  echo "==> applying ${f} as ${origin} (dataset ${DATASET})"
  code=$(curl -sS -o /tmp/apply-slo.$$ -w '%{http_code}' --max-time 30 \
    -X PUT "${DASH0_API_URL%/}/api/slos/${origin}?dataset=${DATASET}" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$json") || { echo "request failed" >&2; rm -f /tmp/apply-slo.$$; exit 1; }
  body="$(cat /tmp/apply-slo.$$)"; rm -f /tmp/apply-slo.$$
  if [[ "$code" =~ ^2 ]]; then
    id="$(printf '%s' "$body" | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log((d.metadata&&d.metadata.labels&&d.metadata.labels["dash0.com/id"])||"")}catch(e){console.log("")}')"
    echo "    HTTP ${code}${id:+  id ${id}}"
    echo "    open: https://app.dash0.com/alerting/slos  (Alerting > SLOs${id:+, id ${id}})"
    echo "    charts stay empty for a few minutes: Dash0 evaluates from creation time with a 5-minute settling delay and does not backfill."
  else
    echo "    HTTP ${code}: ${body}" >&2
    exit 1
  fi
done
