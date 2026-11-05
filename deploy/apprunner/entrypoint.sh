#!/bin/bash
# Runs DB migrations, then boots the server. App Runner may start
# replacement instances at any time, so this runs on EVERY instance start;
# sequelize-cli migrations are idempotent (SequelizeMeta table), which makes
# that safe. The service's health-check grace period absorbs the migration
# time on cold start.
set -euo pipefail

echo "==> entrypoint: running migrations"
cd /app/backend
./migrate.sh

echo "==> entrypoint: starting server"
exec node server.js
