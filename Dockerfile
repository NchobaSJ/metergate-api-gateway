# =============================================================================
# MeterGate — multi-stage Dockerfile
# =============================================================================
# Stage 1: builder
#   - Installs dev dependencies
#   - Compiles TypeScript to JavaScript
#   - Produces the dist/ folder
#
# Stage 2: runtime
#   - Copies ONLY dist/ and node_modules (prod deps)
#   - Runs as non-root user
#   - Small image (~150MB) with no build tools
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first — this layer is cached unless dependencies change.
COPY package.json package-lock.json ./

# Install ALL deps (including devDependencies) to run tsc.
RUN npm ci

# Copy the rest of the source.
COPY tsconfig.json ./
COPY src ./src

# Compile.
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# Create a non-root user to run the app.
RUN addgroup -S metergate && adduser -S metergate -G metergate

# Copy manifests.
COPY package.json package-lock.json ./

# Install only production dependencies.
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled output from the builder stage.
COPY --from=builder /app/dist ./dist

# Drop privileges.
USER metergate

# Default env — override in compose.
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000 4000

# No CMD — docker-compose supplies the command per service.
