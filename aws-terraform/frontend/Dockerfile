# Stage 1: Build the React app
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY public/ ./public/
COPY src/ ./src/

# Accept build-time env vars
ARG REACT_APP_AUTH_SERVICE_URL
ARG REACT_APP_PRODUCT_SERVICE_URL
ARG REACT_APP_ORDER_SERVICE_URL

ENV REACT_APP_AUTH_SERVICE_URL=$REACT_APP_AUTH_SERVICE_URL
ENV REACT_APP_PRODUCT_SERVICE_URL=$REACT_APP_PRODUCT_SERVICE_URL
ENV REACT_APP_ORDER_SERVICE_URL=$REACT_APP_ORDER_SERVICE_URL

RUN npm run build

# Stage 2: Serve with Nginx + envsubst for runtime config injection
FROM nginx:1.25-alpine

# Install gettext for envsubst
RUN apk add --no-cache gettext

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy config template (uses ${INTERNAL_ALB_URL} placeholder)
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Copy built app
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1

# envsubst replaces ${INTERNAL_ALB_URL} at container start, then starts nginx
CMD ["/bin/sh", "-c", \
  "envsubst '${INTERNAL_ALB_URL}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
