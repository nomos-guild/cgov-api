FROM node:20 AS builder

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
FROM node:20 AS runner

WORKDIR /usr/src/app

# Install system dependencies required by Puppeteer's bundled Chromium
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxshmfence1 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

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
