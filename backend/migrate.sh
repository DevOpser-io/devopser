#!/bin/bash
# Script to run database migrations with AWS Secrets Manager credentials

set -e

echo "=== Database Migration Script ==="
echo "Running in directory: $(pwd)"

# Check if we're in the backend directory
if [ ! -f "./config/database.js" ]; then
  echo "Error: This script must be run from the backend directory"
  echo "Current directory: $(pwd)"
  echo "Contents: $(ls -la)"
  cd /app/backend || exit 1
  echo "Changed to /app/backend directory"
  echo "Contents: $(ls -la)"
fi

# Print environment variables (explicit allowlist of non-sensitive vars only)
# A name-substring filter is not redaction: values under lowercase keys leak.
echo "=== Environment Variables ==="
for v in NODE_ENV REGION DB_HOST DB_PORT DB_NAME PORT; do
  printf '%s=%s\n' "$v" "$(printenv "$v")"
done

# Check if required environment variables are set
if [ -z "$REGION" ]; then
  echo "Error: REGION environment variable is not set"
  exit 1
fi

if [ -z "$DB_NAME_SECRET_NAME" ] || [ -z "$DB_USER_SECRET_NAME" ] || [ -z "$DB_PASSWORD_SECRET_NAME" ] || [ -z "$DB_HOST_SECRET_NAME" ] || [ -z "$DB_PORT_SECRET_NAME" ]; then
  echo "Error: One or more required secret name environment variables are not set"
  echo "DB_NAME_SECRET_NAME: $DB_NAME_SECRET_NAME"
  echo "DB_USER_SECRET_NAME: $DB_USER_SECRET_NAME"
  echo "DB_PASSWORD_SECRET_NAME: $DB_PASSWORD_SECRET_NAME"
  echo "DB_HOST_SECRET_NAME: $DB_HOST_SECRET_NAME"
  echo "DB_PORT_SECRET_NAME: $DB_PORT_SECRET_NAME"
  exit 1
fi

# Retrieve secrets from AWS Secrets Manager and set as environment variables
echo "=== Retrieving Secrets ==="

# Get DB Name
if [ -n "$DB_NAME_SECRET_NAME" ]; then
  DB_NAME=$(aws secretsmanager get-secret-value --secret-id "$DB_NAME_SECRET_NAME" --region "$REGION" --query SecretString --output text)
  export DB_NAME
  echo "Retrieved DB_NAME from AWS Secrets Manager"
fi

# Get DB User
if [ -n "$DB_USER_SECRET_NAME" ]; then
  DB_USER=$(aws secretsmanager get-secret-value --secret-id "$DB_USER_SECRET_NAME" --region "$REGION" --query SecretString --output text)
  export DB_USER
  echo "Retrieved DB_USER from AWS Secrets Manager"
fi

# Get DB Password
if [ -n "$DB_PASSWORD_SECRET_NAME" ]; then
  DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$DB_PASSWORD_SECRET_NAME" --region "$REGION" --query SecretString --output text)
  export DB_PASSWORD
  echo "Retrieved DB_PASSWORD from AWS Secrets Manager"
fi

# Get DB Host
if [ -n "$DB_HOST_SECRET_NAME" ]; then
  DB_HOST=$(aws secretsmanager get-secret-value --secret-id "$DB_HOST_SECRET_NAME" --region "$REGION" --query SecretString --output text)
  export DB_HOST
  echo "Retrieved DB_HOST from AWS Secrets Manager"
fi

# Get DB Port
if [ -n "$DB_PORT_SECRET_NAME" ]; then
  DB_PORT=$(aws secretsmanager get-secret-value --secret-id "$DB_PORT_SECRET_NAME" --region "$REGION" --query SecretString --output text)
  export DB_PORT
  echo "Retrieved DB_PORT from AWS Secrets Manager"
fi

# Print database configuration (without password)
echo "=== Database Configuration ==="
echo "DB_NAME: $DB_NAME"
echo "DB_USER: $DB_USER"
echo "DB_HOST: $DB_HOST"
echo "DB_PORT: $DB_PORT"

# Create a temporary config file for Sequelize CLI
echo "=== Creating temporary config file ==="
TEMP_CONFIG_PATH="./temp-db-config.json"

cat > "$TEMP_CONFIG_PATH" <<EOL
{
  "development": {
    "username": "$DB_USER",
    "password": "$DB_PASSWORD",
    "database": "$DB_NAME",
    "host": "$DB_HOST",
    "port": $DB_PORT,
    "dialect": "postgres",
    "logging": false
  },
  "test": {
    "username": "$DB_USER",
    "password": "$DB_PASSWORD",
    "database": "$DB_NAME",
    "host": "$DB_HOST",
    "port": $DB_PORT,
    "dialect": "postgres",
    "logging": false
  },
  "production": {
    "username": "$DB_USER",
    "password": "$DB_PASSWORD",
    "database": "$DB_NAME",
    "host": "$DB_HOST",
    "port": $DB_PORT,
    "dialect": "postgres",
    "logging": false,
    "dialectOptions": {
      "ssl": {
        "require": true,
        "rejectUnauthorized": false
      }
    }
  }
}
EOL

echo "Created temporary config file at $TEMP_CONFIG_PATH"

# Run the migration with the temporary config file
echo "=== Running database migration ==="
NODE_ENV=production npx sequelize-cli db:migrate --config "$TEMP_CONFIG_PATH"

# Clean up the temporary config file
rm "$TEMP_CONFIG_PATH"
echo "Removed temporary config file"

echo "=== Migration completed ==="
