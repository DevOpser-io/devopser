# DevOpser Site Renderer
# A stateless container that renders websites from JSON configuration
#
# Security: Runs as non-root user, minimal attack surface, no shell access
# NIST CSF: PR.DS-2 (Data-in-transit protection via HTTPS at load balancer)
#           PR.IP-1 (Baseline configuration)
#           PR.PT-3 (Least functionality principle)

FROM node:24.22.1-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production && npm cache clean --force

# Production image
FROM node:24.22.1-alpine

# Security: Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY server.js ./

# Security: Set proper file permissions
RUN chown -R appuser:appgroup /app

# Security: Run as non-root user
USER appuser

# Expose port (HTTP - HTTPS termination at load balancer)
EXPOSE 80

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Environment variables (set at runtime)
ENV NODE_ENV=production \
    PORT=80

# Start the renderer
CMD ["node", "server.js"]

# Labels for container metadata
LABEL org.opencontainers.image.title="DevOpser Site Renderer" \
      org.opencontainers.image.description="Stateless container that renders websites from JSON configuration" \
      org.opencontainers.image.vendor="DevOpser" \
      org.opencontainers.image.version="1.0.0" \
      security.nist.csf.function="Protect" \
      security.nist.csf.category="PR.DS,PR.IP,PR.PT"
