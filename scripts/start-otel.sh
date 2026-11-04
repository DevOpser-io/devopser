#!/usr/bin/env bash
# Start the backend with OpenTelemetry zero-code instrumentation, exporting
# to Dash0 over OTLP/HTTP.
#
# The SDK reads its OTEL_* variables when node starts, before any app code
# (and before backend/config loads .env), so this script derives them from
# three Dash0 values and puts them in the environment first:
#
#   DASH0_OTLP_URL     https://ingress.<region>.aws.dash0.com  (ingress host, not api.)
#   DASH0_AUTH_TOKEN   auth_...  with Ingesting permission
#   DASH0_DATASET      dataset id (default: default)
#
# This script does NOT load .env itself. The repo .env stores DASH0_AUTH_TOKEN
# as a 1Password reference (op://...), so anything that reads the file
# directly would see the literal reference. Start it through the manager,
# which resolves the reference into this process's environment:
#
#   op run --env-file=.env -- ./scripts/start-otel.sh
#   op run --env-file=.env -- npm run start:otel
#
# In CI or on a host where the values are already in the environment (a
# secret store, the App Runner template), run it directly.
#
# Anything already set (OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, ...)
# wins over the derived default, so the deployed workload's explicit
# variables are left untouched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- token guard ----------
TOKEN="${DASH0_AUTH_TOKEN:-}"
if [[ -z "${TOKEN}" ]]; then
  fail "DASH0_AUTH_TOKEN is not set. .env keeps it as a 1Password reference, so start as:
   op run --env-file=.env -- ./scripts/start-otel.sh"
fi
if [[ "${TOKEN}" == op://* ]]; then
  fail "DASH0_AUTH_TOKEN is an unresolved 1Password reference (op://...). Start as:
   op run --env-file=.env -- ./scripts/start-otel.sh"
fi
[[ -n "${DASH0_OTLP_URL:-}" ]] || fail "DASH0_OTLP_URL is not set (the OTLP/HTTP ingress host from Settings > Endpoints)"
case "${DASH0_OTLP_URL}" in
  *api.*) fail "DASH0_OTLP_URL points at the API host (${DASH0_OTLP_URL}); telemetry goes to the ingress host";;
esac
DATASET="${DASH0_DATASET:-default}"

# ---------- resource identity ----------
# service.name / service.namespace must stay identical everywhere: here, in
# deploy/apprunner/cloudformation.yaml, on the deployment event and in the
# SLO's spec.service. service.version is the release identifier the deploy
# pipeline produces (image tag or git SHA); locally it falls back to the
# short git SHA, then "dev".
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-slo-demo}"
if [[ -z "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
  VERSION="${SERVICE_VERSION:-$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo dev)}"
  ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT:-local}"
  export OTEL_RESOURCE_ATTRIBUTES="service.namespace=slo-demo,service.version=${VERSION},deployment.environment.name=${ENVIRONMENT}"
fi

# ---------- exporter ----------
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-${DASH0_OTLP_URL}}"
export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
export OTEL_EXPORTER_OTLP_HEADERS="${OTEL_EXPORTER_OTLP_HEADERS:-Authorization=Bearer ${TOKEN},Dash0-Dataset=${DATASET}}"
# Set all three explicitly; older SDKs default metrics or logs to none.
export OTEL_TRACES_EXPORTER="${OTEL_TRACES_EXPORTER:-otlp}"
export OTEL_METRICS_EXPORTER="${OTEL_METRICS_EXPORTER:-otlp}"
export OTEL_LOGS_EXPORTER="${OTEL_LOGS_EXPORTER:-otlp}"
# Surface exporter status (including auth failures) on stdout.
export OTEL_LOG_LEVEL="${OTEL_LOG_LEVEL:-info}"

# Endpoint, dataset and identity only. The token is never printed.
echo "[otel] exporting to ${OTEL_EXPORTER_OTLP_ENDPOINT} (dataset ${DATASET}) as ${OTEL_SERVICE_NAME} [${OTEL_RESOURCE_ATTRIBUTES}]"

# ---------- start ----------
# CommonJS app: --require (an ESM app would use --import). The register hook
# must come first so the SDK exists before the console bridge or any app
# module loads. No --env-file: the app's own dotenv loads the rest of .env
# at runtime for its non-telemetry settings, and the environment wins there.
cd "${REPO_ROOT}/backend"
exec node \
  --require @opentelemetry/auto-instrumentations-node/register \
  --require ./otel-console-bridge.js \
  server.js
