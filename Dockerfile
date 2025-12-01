FROM node:20-alpine AS builder

# Working Dir
WORKDIR /base

# Copy Prisma schema first (needed for install hooks)
COPY prisma ./prisma

# Copy package files
COPY package.json yarn.lock* ./

# Install ALL dependencies (including devDependencies for build)
RUN yarn install --frozen-lockfile

# Copy source files
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript (builds both index.ts and cron.ts)
RUN yarn build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Copy built files from builder
COPY --from=builder /base/.build ./.build
COPY --from=builder /base/package.json ./
COPY --from=builder /base/yarn.lock* ./
COPY --from=builder /base/prisma ./prisma

# Copy swagger docs if they exist
COPY --from=builder /base/docs ./docs

# Install only production dependencies
RUN yarn install --frozen-lockfile --production

# Generate Prisma client in production stage
RUN npx prisma generate

# Expose port (only used by API service)
EXPOSE 3000

# Default command (can be overridden in docker-compose)
CMD ["node", ".build/index.js"]
