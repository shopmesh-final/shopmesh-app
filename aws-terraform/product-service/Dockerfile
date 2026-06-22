FROM node:20-alpine

WORKDIR /app

# Install dependencies separately for better layer caching
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 -G nodejs && \
    chown -R nodeuser:nodejs /app

USER nodeuser

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "src/index.js"]
