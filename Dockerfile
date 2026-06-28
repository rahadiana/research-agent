# =============================================================================
# Research Agent — Multi-Stage Docker Build
# =============================================================================

# ── Stage 1: Install dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy lockfiles for layer caching
COPY package.json package-lock.json ./

# Install ALL dependencies (devDeps needed for TypeScript build)
RUN npm ci

# ── Stage 2: Build TypeScript ────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 3: Production image ────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install opencode CLI global
RUN npm install -g opencode-ai@latest 2>&1 | tail -3

# Install opencode plugin: agentic engine (search, tools, etc)
RUN opencode plugin opencode-agentic-engine@latest --global 2>&1

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only production deps from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled output
COPY --from=build /app/dist ./dist

# Copy views (EJS templates for dashboard)
COPY --from=build /app/src/dashboard/views ./dist/dashboard/views

# Copy data directory structure (created at runtime if needed)
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Default port for dashboard
EXPOSE 3000

# Healthcheck — cek endpoint /health
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default: run dashboard (via CLI)
# Override untuk CLI usage: docker run ... node dist/cli/index.js research run <topic>
CMD ["node", "dist/cli/index.js", "dashboard"]
