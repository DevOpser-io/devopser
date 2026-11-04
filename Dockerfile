# Minimal Docker image for Bedrock Express.
#
# This image is intended for self-hosted / local use: it brings your code up
# on port 8000 and leaves infrastructure (PostgreSQL, Redis, AWS credentials)
# to be supplied via environment variables at runtime.
#
# Managed hosting on app.devopser.io uses its own image/build pipeline and
# will replace this file during integration — keep it simple here.

FROM node:24.22.1-slim

WORKDIR /app

# Copy source and install dependencies (frontend + backend in one go).
COPY --chown=node:node . .
RUN npm run install:all && npm run frontend:build

# Development mode by default — the backend reads POSTGRES_*, REDIS_URL, and
# AWS credentials straight from environment variables in this mode. Production
# mode expects AWS Secrets Manager and is covered in SELF_HOSTING.md.
ENV NODE_ENV=development
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

USER node

CMD ["npm", "run", "backend:start"]
