#!/bin/bash
# ─── Backend EC2 User Data Script ─────────────────────────────────────────
# Installs Docker + Docker Compose, configures environment from instance
# metadata and SSM/Secrets Manager, and starts all 3 backend services.

set -euo pipefail

# Template variables injected by Terraform templatefile()
PROJECT_NAME="${project_name}"
AWS_REGION="${aws_region}"
ECR_REGISTRY="${ecr_registry}"
IMAGE_TAG="${docker_image_tag}"
DYNAMODB_USERS_TABLE="${dynamodb_users_table}"
DYNAMODB_PRODUCTS_TABLE="${dynamodb_products_table}"
DYNAMODB_ORDERS_TABLE="${dynamodb_orders_table}"
SQS_ORDER_QUEUE_URL="${sqs_order_queue_url}"
SNS_ORDERS_TOPIC_ARN="${sns_orders_topic_arn}"
SNS_ALERTS_TOPIC_ARN="${sns_alerts_topic_arn}"

LOG_FILE="/var/log/shopmesh-backend-userdata.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== ShopMesh Backend Bootstrap START $(date) ==="

# ─── 1. Update system ─────────────────────────────────────────────────────
yum update -y

# ─── 2. Install Docker ────────────────────────────────────────────────────
yum install -y docker
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# ─── 3. Install Docker Compose ────────────────────────────────────────────
COMPOSE_VERSION="v2.24.6"
curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose

# ─── 4. Install CloudWatch Agent ──────────────────────────────────────────
yum install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<EOF
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/shopmesh-backend-userdata.log",
            "log_group_name": "/shopmesh/backend",
            "log_stream_name": "{instance_id}",
            "retention_in_days": 30
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "ShopMesh/Backend",
    "metrics_collected": {
      "cpu": { "measurement": ["cpu_usage_active"] },
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["disk_used_percent"] }
    }
  }
}
EOF
systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent

# ─── 5. Create app directory ──────────────────────────────────────────────
mkdir -p /opt/shopmesh/backend

# ─── 6. Authenticate to ECR (if configured) ───────────────────────────────
if [ -n "$ECR_REGISTRY" ]; then
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  AUTH_IMAGE="$ECR_REGISTRY/$PROJECT_NAME/auth-service:$IMAGE_TAG"
  PRODUCT_IMAGE="$ECR_REGISTRY/$PROJECT_NAME/product-service:$IMAGE_TAG"
  ORDER_IMAGE="$ECR_REGISTRY/$PROJECT_NAME/order-service:$IMAGE_TAG"
else
  # Build from repo
  yum install -y git
  git clone https://github.com/priyatham7753/tempo3.git /opt/shopmesh/repo
  docker build -t shopmesh-auth:latest /opt/shopmesh/repo/auth-service/
  docker build -t shopmesh-products:latest /opt/shopmesh/repo/product-service/
  docker build -t shopmesh-orders:latest /opt/shopmesh/repo/order-service/
  AUTH_IMAGE="shopmesh-auth:latest"
  PRODUCT_IMAGE="shopmesh-products:latest"
  ORDER_IMAGE="shopmesh-orders:latest"
fi

# ─── 7. Write backend docker-compose.yml ──────────────────────────────────
cat > /opt/shopmesh/backend/docker-compose.yml <<EOF
services:
  auth-service:
    image: $AUTH_IMAGE
    container_name: shopmesh-auth
    restart: always
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - NODE_ENV=production
      - LOCAL_MODE=false
      - AWS_REGION=$AWS_REGION
      - DYNAMODB_USERS_TABLE=$DYNAMODB_USERS_TABLE
      - JWT_EXPIRES_IN=24h
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s

  product-service:
    image: $PRODUCT_IMAGE
    container_name: shopmesh-products
    restart: always
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
      - NODE_ENV=production
      - LOCAL_MODE=false
      - AWS_REGION=$AWS_REGION
      - DYNAMODB_PRODUCTS_TABLE=$DYNAMODB_PRODUCTS_TABLE
      - SNS_ORDERS_TOPIC_ARN=$SNS_ORDERS_TOPIC_ARN
      - SNS_ALERTS_TOPIC_ARN=$SNS_ALERTS_TOPIC_ARN
      - S3_PRODUCT_IMAGES_BUCKET=$PROJECT_NAME-product-images
      - AUTH_SERVICE_URL=http://localhost:3001
    depends_on:
      auth-service:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 40s

  order-service:
    image: $ORDER_IMAGE
    container_name: shopmesh-orders
    restart: always
    ports:
      - "3003:3003"
    environment:
      - PORT=3003
      - LOCAL_MODE=false
      - AWS_REGION=$AWS_REGION
      - DYNAMODB_ORDERS_TABLE=$DYNAMODB_ORDERS_TABLE
      - SQS_ORDER_QUEUE_URL=$SQS_ORDER_QUEUE_URL
      - SNS_ORDERS_TOPIC_ARN=$SNS_ORDERS_TOPIC_ARN
      - SNS_ALERTS_TOPIC_ARN=$SNS_ALERTS_TOPIC_ARN
      - AUTH_SERVICE_URL=http://localhost:3001
      - PRODUCT_SERVICE_URL=http://localhost:3002
    depends_on:
      auth-service:
        condition: service_healthy
      product-service:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:3003/health')"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s
EOF

# ─── 8. Start backend services ────────────────────────────────────────────
cd /opt/shopmesh/backend
docker-compose up -d

# ─── 9. Configure auto-restart on reboot ──────────────────────────────────
cat > /etc/systemd/system/shopmesh-backend.service <<EOF
[Unit]
Description=ShopMesh Backend Services
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/shopmesh/backend
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
EOF

systemctl enable shopmesh-backend

echo "=== ShopMesh Backend Bootstrap DONE $(date) ==="
echo "Services: auth=3001, products=3002, orders=3003"
