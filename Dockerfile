# Use Node.js 22 Alpine for smaller image size
FROM node:22-alpine AS builder

# Working directory
WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source files and prisma schema
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript
RUN npx tsc

# Production stage
FROM node:22-alpine

WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /usr/src/app/.build ./.build
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma

# Copy prisma schema for migrations
COPY prisma ./prisma

# Cloud Run sets PORT environment variable
ENV NODE_ENV=production

# Expose port (Cloud Run will override this)
EXPOSE 8080

# Start the application
CMD ["node", ".build/index.js"]
