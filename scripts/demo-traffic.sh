#!/usr/bin/env bash
# Steady demo traffic for the deployed slo-demo, so the SLO has events to
# count and an incident has something to break. Three of four requests hit the
# landing page (subject to demo faults), one of four hits /api/health (never
# faulted). Prints one summary line per minute: total, 2xx, 5xx, slow (>0.5 s).
#
# Usage: scripts/demo-traffic.sh [requests per second, default 1] [base url]
# The base url defaults to BASE_URL from the environment, then the App Runner
# service url. Stop with Ctrl-C or kill. Keep the laptop awake:
#   caffeinate -i scripts/demo-traffic.sh
set -uo pipefail
RPS="${1:-1}"
BASE="${2:-${BASE_URL:-https://ftkqrb74sz.eu-west-1.awsapprunner.com}}"
INTERVAL=$(python3 -c "print(1.0/float('${RPS}'))")
PATHS=(/ / / /api/health)
n=0; ok=0; err=0; slow=0; minute=$(date +%H:%M)
echo "$(date '+%F %T') demo traffic -> ${BASE} at ${RPS} req/s (Ctrl-C to stop)"
while :; do
  p="${PATHS[$((n % ${#PATHS[@]}))]}"
  out=$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{time_total}' "${BASE}${p}" 2>/dev/null || echo "000 0")
  code="${out%% *}"; t="${out##* }"
  n=$((n + 1))
  case "${code}" in 2*) ok=$((ok + 1)) ;; 5*|000) err=$((err + 1)) ;; esac
  awk -v t="${t}" 'BEGIN { exit !(t > 0.5) }' && slow=$((slow + 1))
  now=$(date +%H:%M)
  if [[ "${now}" != "${minute}" ]]; then
    echo "$(date '+%F') ${minute} total=${n} 2xx=${ok} 5xx=${err} slow=${slow}"
    n=0; ok=0; err=0; slow=0; minute="${now}"
  fi
  sleep "${INTERVAL}"
done
