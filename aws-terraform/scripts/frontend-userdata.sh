#!/bin/bash
# ─── Frontend EC2 User Data Script ────────────────────────────────────────
# Installs Docker, pulls and runs the frontend container on ASG instances.
# Executed at EC2 boot by the launch template.

set -euo pipefail

# Template variables injected by Terraform templatefile()
PROJECT_NAME="${project_name}"
INTERNAL_ALB_DNS="${internal_alb_dns}"
AWS_REGION="${aws_region}"
ECR_REGISTRY="${ecr_registry}"
IMAGE_TAG="${docker_image_tag}"

LOG_FILE="/var/log/shopmesh-userdata.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== ShopMesh Frontend Bootstrap START $(date) ==="

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
            "file_path": "/var/log/shopmesh-userdata.log",
            "log_group_name": "/shopmesh/frontend",
            "log_stream_name": "{instance_id}",
            "retention_in_days": 30
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "ShopMesh/Frontend",
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

# ─── 5. Authenticate to ECR (if ECR registry is configured) ───────────────
if [ -n "$ECR_REGISTRY" ]; then
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  FRONTEND_IMAGE="$ECR_REGISTRY/$PROJECT_NAME/frontend:$IMAGE_TAG"
else
  # Fallback: build from repo (for initial deployment without ECR)
  yum install -y git
  git clone https://github.com/priyatham7753/tempo3.git /opt/shopmesh
  cd /opt/shopmesh/frontend
  docker build \
    --build-arg REACT_APP_INTERNAL_ALB_URL="http://$INTERNAL_ALB_DNS" \
    -t shopmesh-frontend:latest .
  FRONTEND_IMAGE="shopmesh-frontend:latest"
fi

# ─── 6. Create app directory ──────────────────────────────────────────────
mkdir -p /opt/shopmesh/frontend

# ─── 7. Write docker-compose.yml ──────────────────────────────────────────
cat > /opt/shopmesh/frontend/docker-compose.yml <<EOF
services:
  frontend:
    image: $FRONTEND_IMAGE
    container_name: shopmesh-frontend
    restart: always
    ports:
      - "80:80"
    environment:
      - INTERNAL_ALB_URL=http://$INTERNAL_ALB_DNS
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
EOF

# ─── 8. Start frontend container ──────────────────────────────────────────
cd /opt/shopmesh/frontend
docker-compose up -d

# ─── 9. Configure auto-restart on reboot ──────────────────────────────────
cat > /etc/systemd/system/shopmesh-frontend.service <<EOF
[Unit]
Description=ShopMesh Frontend
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/shopmesh/frontend
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl enable shopmesh-frontend

echo "=== ShopMesh Frontend Bootstrap DONE $(date) ==="
