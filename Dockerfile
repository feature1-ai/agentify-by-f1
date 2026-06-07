# Multi-stage build for optimized image size
FROM node:20-slim AS builder

# Install dependencies required for building native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Second stage - runtime (debian-slim, not alpine: OpenAI Codex CLI ships glibc-linked binaries)
FROM node:20-slim

# Install OpenAI Codex CLI globally + runtime utils
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates && \
    npm install -g @openai/codex && \
    rm -rf /var/lib/apt/lists/* /root/.npm

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs -m -d /home/nodejs nodejs

# Create app directory
WORKDIR /app

# Copy node modules from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs . .

# Copy and make entrypoint executable
COPY --chown=nodejs:nodejs scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create necessary directories
RUN mkdir -p logs resources/contexts resources/templates resources/schemas && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment variables
# Note: OPENAI_API_KEY must be provided at runtime — entrypoint logs Codex CLI in with it
ENV NODE_ENV=production \
    PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Start the application
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]