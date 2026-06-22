# ShopMesh — AWS Cloud-Native Microservices

A fully production-ready AWS cloud-native e-commerce platform built with microservices architecture.
Deployable via Terraform, runnable locally with Docker Compose.

## Architecture

```
Internet
   │
   ▼
CloudFront (HTTPS, edge caching)
   │
   ▼
External Application Load Balancer (Public, port 80/443)
   │
   ▼
Frontend Auto Scaling Group (EC2, public subnets, min=1 desired=2 max=4)
   │  Nginx → proxies /api/* to Internal ALB
   ▼
Internal Application Load Balancer (Private)
   ├── /api/auth/*     → Auth Service    (port 3001, Node.js)
   ├── /api/products/* → Product Service (port 3002, Node.js)
   └── /api/orders/*   → Order Service   (port 3003, Python/FastAPI)
              │
              ▼
Backend Auto Scaling Group (EC2, private subnets, min=1 desired=2 max=4)
              │
    ┌─────────┼─────────────────────┐
    ▼         ▼                     ▼
 DynamoDB   SQS + SNS        Secrets Manager
 (3 tables) (events)         (jwt-secret)

Monitoring: CloudWatch + EventBridge
Storage:    S3 (product images, ALB logs, CloudFront logs)
```

## Services

| Service | Language | Port | Description |
|---------|----------|------|-------------|
| frontend | React + Nginx | 80 | SPA with React Router |
| auth-service | Node.js/Express | 3001 | JWT auth with DynamoDB |
| product-service | Node.js/Express | 3002 | Product CRUD, S3 uploads |
| order-service | Python/FastAPI | 3003 | Orders, SQS consumer, SNS |

## Repository Structure

```
tempo3/
├── auth-service/          # Node.js auth service (DynamoDB)
│   └── src/
│       ├── db/dynamodb.js
│       ├── repositories/userRepository.js
│       ├── routes/auth.js
│       └── middleware/auth.js
├── product-service/       # Node.js product service (DynamoDB + SNS + S3)
│   └── src/
│       ├── db/dynamodb.js
│       ├── repositories/productRepository.js
│       ├── services/snsService.js
│       └── services/s3Service.js
├── order-service/         # Python/FastAPI order service (DynamoDB + SQS + SNS)
│   └── app/
│       ├── db/dynamodb.py
│       ├── repositories/order_repository.py
│       ├── services/sqs_service.py
│       ├── services/sns_service.py
│       └── workers/sqs_consumer.py
├── frontend/              # React SPA + Nginx
│   ├── docker-compose.yml
│   └── src/services/api.js
├── backend/               # Backend docker-compose (local dev)
│   └── docker-compose.yml
├── scripts/
│   ├── frontend-userdata.sh   # EC2 bootstrap for frontend ASG
│   ├── backend-userdata.sh    # EC2 bootstrap for backend ASG
│   └── init-dynamodb-local.sh # DynamoDB Local table creation
└── terraform/             # Full infrastructure as code
    ├── main.tf
    ├── variables.tf
    ├── outputs.tf
    ├── providers.tf
    ├── versions.tf
    ├── terraform.tfvars.example
    └── modules/
        ├── vpc/               ├── alb/           ├── cloudfront/
        ├── security-groups/   ├── launch-template/├── dynamodb/
        ├── iam/               ├── asg/            ├── s3/
        ├── secretsmanager/    ├── sns/            ├── sqs/
        ├── cloudwatch/        └── eventbridge/
```

---

## 1. Local Development

### Prerequisites
- Docker Desktop
- AWS CLI (for local scripts)
- Node.js 20+ (optional, for `npm run dev`)

### Quick Start

```bash
# Clone the repository
git clone -b nk-helm https://github.com/priyatham7753/tempo3.git
cd tempo3
```

---

## 2. Docker Compose Execution

### Backend (DynamoDB Local + all 3 services)

```bash
cd backend

# Start all backend services + DynamoDB Local
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f

# Test health endpoints
curl http://localhost:3001/health    # auth-service
curl http://localhost:3002/health    # product-service
curl http://localhost:3003/health    # order-service
```

### Frontend (separate compose)

```bash
cd frontend

# Start frontend (assumes backend is running on localhost ports)
docker compose up -d

# Access at:
# http://localhost:3000
```

### Full stack (backend + frontend together)

```bash
# From repo root, start backend first
docker compose -f backend/docker-compose.yml up -d

# Wait for services to be healthy, then start frontend
docker compose -f frontend/docker-compose.yml up -d
```

---

## 3. DynamoDB Local Execution

DynamoDB Local runs automatically inside `backend/docker-compose.yml`. Tables are bootstrapped by the `dynamodb-init` container on startup.

### Manual table creation

```bash
# Ensure DynamoDB Local is running
docker compose -f backend/docker-compose.yml up dynamodb-local -d

# Set environment
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export DYNAMODB_ENDPOINT=http://localhost:8000

# Run init script
bash scripts/init-dynamodb-local.sh

# Verify tables
aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-east-1
```

---

## 4. Terraform Deployment

### Prerequisites

```bash
# Install Terraform >= 1.6.0
# Configure AWS CLI
aws configure
# or export:
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_DEFAULT_REGION=us-east-1
```

### Initialize and Deploy

```bash
cd terraform

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Initialize providers
terraform init

# Validate configuration
terraform validate

# Preview changes
terraform plan

# Apply (will create ~60 AWS resources)
terraform apply
```

### Destroy

```bash
terraform destroy
```

---

## 5. AWS Deployment

After `terraform apply` completes:

1. **Get outputs:**
   ```bash
   terraform output cloudfront_domain_name   # Application URL
   terraform output external_alb_dns_name    # ALB URL
   terraform output sqs_order_queue_url      # SQS Queue URL
   ```

2. **Build and push Docker images to ECR:**
   ```bash
   # Create ECR repositories (first time)
   aws ecr create-repository --repository-name shopmesh/auth-service
   aws ecr create-repository --repository-name shopmesh/product-service
   aws ecr create-repository --repository-name shopmesh/order-service
   aws ecr create-repository --repository-name shopmesh/frontend

   # Authenticate
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin $ECR_REGISTRY

   # Build and push
   docker build -t $ECR_REGISTRY/shopmesh/auth-service:latest ./auth-service/
   docker push $ECR_REGISTRY/shopmesh/auth-service:latest

   docker build -t $ECR_REGISTRY/shopmesh/product-service:latest ./product-service/
   docker push $ECR_REGISTRY/shopmesh/product-service:latest

   docker build -t $ECR_REGISTRY/shopmesh/order-service:latest ./order-service/
   docker push $ECR_REGISTRY/shopmesh/order-service:latest

   docker build \
     --build-arg REACT_APP_INTERNAL_ALB_URL=http://$(terraform -chdir=terraform output -raw internal_alb_dns_name) \
     -t $ECR_REGISTRY/shopmesh/frontend:latest ./frontend/
   docker push $ECR_REGISTRY/shopmesh/frontend:latest
   ```

3. **Trigger ASG instance refresh:**
   ```bash
   aws autoscaling start-instance-refresh \
     --auto-scaling-group-name shopmesh-frontend-asg \
     --preferences '{"MinHealthyPercentage":50}'

   aws autoscaling start-instance-refresh \
     --auto-scaling-group-name shopmesh-backend-asg \
     --preferences '{"MinHealthyPercentage":50}'
   ```

4. **Access the application:**
   ```
   https://<cloudfront_domain_name>
   ```

---

## 6. Auto Scaling Verification

```bash
# Check ASG status
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names shopmesh-frontend-asg shopmesh-backend-asg \
  --query 'AutoScalingGroups[*].{Name:AutoScalingGroupName,Min:MinSize,Desired:DesiredCapacity,Max:MaxSize,Instances:length(Instances)}'

# Check scaling activities
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name shopmesh-backend-asg \
  --max-items 5

# Check scaling policies
aws autoscaling describe-policies \
  --auto-scaling-group-name shopmesh-backend-asg
```

---

## 7. CloudFront Verification

```bash
# Get distribution info
DIST_ID=$(terraform -chdir=terraform output -raw cloudfront_distribution_id)
aws cloudfront get-distribution --id $DIST_ID \
  --query 'Distribution.Status'

# Test CloudFront URL
CF_URL=$(terraform -chdir=terraform output -raw cloudfront_domain_name)
curl -I https://$CF_URL

# Check cache behavior (X-Cache header)
curl -v https://$CF_URL/api/auth/health 2>&1 | grep X-Cache
```

---

## 8. Secrets Manager Verification

```bash
# List secrets
aws secretsmanager list-secrets \
  --filter Key=name,Values=shopmesh \
  --query 'SecretList[*].Name'

# Verify jwt-secret exists and is accessible
aws secretsmanager get-secret-value \
  --secret-id shopmesh/jwt-secret \
  --query 'SecretString' --output text | python3 -c "import sys,json; d=json.load(sys.stdin); print('JWT secret length:', len(d['jwt_secret']))"

# Verify app-config
aws secretsmanager get-secret-value \
  --secret-id shopmesh/app-config \
  --query 'SecretString' --output text | python3 -m json.tool
```

---

## 9. SNS Verification

```bash
# List topics
aws sns list-topics --query 'Topics[*].TopicArn' | grep shopmesh

# Publish a test message to alerts topic
ALERTS_ARN=$(terraform -chdir=terraform output -raw sns_alerts_topic_arn)
aws sns publish \
  --topic-arn $ALERTS_ARN \
  --subject "Test Alert" \
  --message "ShopMesh SNS test message - $(date)"

# List subscriptions
aws sns list-subscriptions-by-topic --topic-arn $ALERTS_ARN
```

---

## 10. SQS Verification

```bash
# Get queue attributes
QUEUE_URL=$(terraform -chdir=terraform output -raw sqs_order_queue_url)
aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names All

# Send a test message
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body '{"event":"order.created","order_id":"test-123","user_email":"test@example.com","total_amount":99.99}' \
  --message-attributes 'event_type={DataType=String,StringValue=order.created}'

# Check queue depth
aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages'
```

---

## 11. EventBridge Verification

```bash
# List rules
aws events list-rules \
  --name-prefix shopmesh \
  --query 'Rules[*].{Name:Name,State:State,Schedule:ScheduleExpression}'

# Enable a rule (if disabled)
aws events enable-rule --name shopmesh-daily-order-summary

# Trigger daily summary manually (test)
aws events put-events --entries '[{
  "Source": "shopmesh.manual",
  "DetailType": "Manual Test",
  "Detail": "{\"event_type\":\"daily_order_summary\",\"manual\":true}"
}]'

# List targets for a rule
aws events list-targets-by-rule --rule shopmesh-hourly-health-check
```

---

## 12. Troubleshooting Guide

### Backend services not starting

```bash
# Check container status
ssh ec2-user@<backend-instance-ip>
sudo docker ps -a

# Check docker compose logs
sudo docker compose -f /opt/shopmesh/backend/docker-compose.yml logs

# Check userdata log
sudo cat /var/log/shopmesh-backend-userdata.log

# Check systemd service
sudo systemctl status shopmesh-backend
```

### Auth service JWT issues

```bash
# Verify secret is loaded correctly (check service logs)
sudo docker logs shopmesh-auth | grep -i "secret\|JWT\|error"

# In AWS, verify Secrets Manager access
aws secretsmanager get-secret-value --secret-id shopmesh/jwt-secret
```

### DynamoDB connection errors (local dev)

```bash
# Verify DynamoDB Local is running
docker ps | grep dynamodb-local

# Check DynamoDB Local endpoint
curl http://localhost:8000

# Re-initialize tables
bash scripts/init-dynamodb-local.sh

# Check service env
docker exec shopmesh-auth env | grep DYNAMODB
```

### Order service SQS errors

```bash
# Check SQS consumer logs
sudo docker logs shopmesh-orders | grep SQS

# Verify queue URL is set
sudo docker exec shopmesh-orders env | grep SQS

# Check queue attributes
aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All
```

### ALB health check failures

```bash
# Check target group health
aws elbv2 describe-target-health \
  --target-group-arn <auth-tg-arn>

# SSH to backend and test locally
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

### CloudFront not serving updates

```bash
# Invalidate CloudFront cache
DIST_ID=$(terraform -chdir=terraform output -raw cloudfront_distribution_id)
aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/*"
```

### Terraform state issues

```bash
# Refresh state
terraform refresh

# Import existing resource
terraform import aws_dynamodb_table.users shopmesh-users

# Show state
terraform state list
terraform state show module.vpc.aws_vpc.main
```

---

## Environment Variables Reference

| Variable | Service | Description |
|----------|---------|-------------|
| `LOCAL_MODE` | All backend | `true` = DynamoDB Local + skip Secrets Manager |
| `AWS_REGION` | All backend | AWS region |
| `DYNAMODB_ENDPOINT` | All backend | DynamoDB Local URL (LOCAL_MODE=true) |
| `DYNAMODB_USERS_TABLE` | auth | DynamoDB users table name |
| `DYNAMODB_PRODUCTS_TABLE` | product | DynamoDB products table name |
| `DYNAMODB_ORDERS_TABLE` | order | DynamoDB orders table name |
| `JWT_SECRET` | auth, product | JWT signing secret (from Secrets Manager in prod) |
| `SQS_ORDER_QUEUE_URL` | order | SQS queue URL for order events |
| `SNS_ORDERS_TOPIC_ARN` | product, order | SNS orders topic ARN |
| `SNS_ALERTS_TOPIC_ARN` | product, order | SNS alerts topic ARN |
| `S3_PRODUCT_IMAGES_BUCKET` | product | S3 bucket for product images |
| `INTERNAL_ALB_URL` | frontend | Internal ALB URL (nginx proxy, injected at runtime) |

---

## Security Notes

- No hardcoded credentials anywhere in the codebase
- JWT secrets auto-generated by Terraform via `random_password`
- Backend EC2 instances run in private subnets (no public IP)
- All IAM roles use least-privilege policies
- DynamoDB tables have encryption at rest + PITR enabled
- S3 buckets have public access blocked
- Security groups restrict traffic to minimum required ports

---

## API Reference

### Auth Service — `POST /api/auth/register`

Register a new user account. Returns a JWT token on success.

**Request body:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "secret123",
  "gender": "Female",
  "age": 28
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | 2–50 characters |
| `email` | string | valid email format |
| `password` | string | minimum 6 characters |
| `gender` | string | `"Male"` \| `"Female"` \| `"Other"` |
| `age` | integer | 13–100 |

**Success response `201`:**
```json
{
  "message": "User registered successfully",
  "token": "<jwt>",
  "user": {
    "userId": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "gender": "Female",
    "age": 28,
    "role": "user",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

**Error responses:**
- `400` — validation failure (`errors` array)
- `409` — email already registered

---

### Product Service — Product Schema

Products stored in DynamoDB include a `stock` field that tracks available inventory.

```json
{
  "productId": "uuid",
  "name": "Wireless Headphones",
  "description": "...",
  "price": 299.99,
  "category": "Electronics",
  "stock": 42,
  "imageUrl": "https://...",
  "isActive": true,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

The `stock` field is decremented atomically when an order is placed and restored automatically if order creation fails. When `stock` drops below 5, an SNS alert is published to `SNS_ALERTS_TOPIC_ARN`.

#### `PATCH /api/products/:id/decrement-stock` (internal)

Called by the order service to atomically decrement stock. Requires a valid JWT.

**Request body:** `{ "quantity": 2 }`

**Responses:**
- `200` — `{ "success": true, "product": { ...updatedProduct } }`
- `400` — invalid quantity
- `409` — `{ "success": false, "message": "Insufficient stock available" }`
- `500` — DynamoDB error

#### `PATCH /api/products/:id/restore-stock` (internal)

Called by the order service to roll back a stock decrement when order creation fails. Requires a valid JWT.

**Request body:** `{ "quantity": 2 }`

**Responses:**
- `200` — `{ "success": true" }`
- `500` — DynamoDB error

---

### Order Service — `POST /api/orders/`

Create a new order. Requires `Authorization: Bearer <token>` header.

**Request body:**
```json
{
  "items": [
    { "product_id": "uuid", "quantity": 2 }
  ],
  "shipping_address": "123 Main St, Springfield, USA"
}
```

**Order creation flow:**

```
1. Validate all products via Product Service (check they exist + pre-check stock)
2. Atomic stock decrement for each item via Product Service
   └── On any failure → rollback all previously decremented items and return 409
3. Build order item list with prices and subtotals
4. Create order record in DynamoDB
   └── On failure → rollback all stock decrements
5. Publish order event to SQS + SNS (non-blocking)
```

**Success response `201`:** Full order object with `order_id`, `status`, `items`, `total_amount`, timestamps.

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{ "detail": "..." }` | Missing or invalid JWT |
| `404` | `{ "detail": "Product X not found" }` | Product does not exist |
| `409` | `{ "success": false, "message": "Insufficient stock available" }` | Not enough stock |
| `500` | `{ "detail": "Order creation failed" }` | DynamoDB write failure (stock already rolled back) |
| `502` | `{ "detail": "Failed to update product stock" }` | Product service error |
| `503` | `{ "detail": "Product service unavailable" }` | Network / timeout |

#### Low Stock Alert

After a successful stock decrement, if the remaining stock falls below **5 units**, the product service publishes an SNS notification to `SNS_ALERTS_TOPIC_ARN` with the following message body:

```
LOW INVENTORY ALERT

Product: Wireless Headphones
Product ID: <uuid>
Remaining Stock: 4
```

The notification reuses the existing `shopmesh-alerts` SNS topic — no new AWS infrastructure is required.

# aws-terraform
