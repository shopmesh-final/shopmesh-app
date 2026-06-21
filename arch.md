# ShopMesh — Full Architecture Reference

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Network & Infrastructure Layer](#2-network--infrastructure-layer)
3. [Compute Layer](#3-compute-layer)
4. [Application Layer — Microservices](#4-application-layer--microservices)
5. [Data Layer](#5-data-layer)
6. [Messaging Layer](#6-messaging-layer)
7. [Security Architecture](#7-security-architecture)
8. [Observability](#8-observability)
9. [Request Flow — Step by Step](#9-request-flow--step-by-step)
10. [Local Development vs Production](#10-local-development-vs-production)

---

## 1. System Overview

ShopMesh is a multi-tier e-commerce platform deployed on AWS in **us-east-1**. It consists of a React single-page application served from EC2 instances behind CloudFront, communicating with six independent backend microservices running in private subnets, with an AI-powered shopping assistant backed by Amazon Bedrock.

```
Internet
   │
   ▼
Route53 (shopmesh.shop)
   │
   ▼
CloudFront CDN  ──── ACM cert (shopmesh.shop, us-east-1)
   │   HTTP/80
   ▼
External ALB  (public subnets, us-east-1a / us-east-1b)
   │   HTTP/80 → frontend target group
   ▼
Frontend ASG  (public subnets — nginx + React bundle)
   │   HTTP → Internal ALB
   ▼
Internal ALB  (private subnets, us-east-1a / us-east-1b)
   │   Path-based routing → backend target groups
   ▼
Backend ASG   (private subnets — 6 microservices via Docker Compose)
   │
   ├── DynamoDB  (VPC Gateway Endpoint — no internet)
   ├── S3        (VPC Gateway Endpoint — no internet)
   ├── SQS / SNS (via NAT Gateway)
   ├── Secrets Manager (via NAT Gateway)
   └── Bedrock   (via NAT Gateway → us-east-1 endpoint)
```

---

## 2. Network & Infrastructure Layer

### VPC

| Resource | Value |
|----------|-------|
| CIDR | `10.0.0.0/16` |
| DNS hostnames | Enabled |
| DNS support | Enabled |

### Subnets (2 Availability Zones)

| Type | AZ | CIDR | Purpose |
|------|----|------|---------|
| Public | us-east-1a | `10.0.1.0/24` | External ALB, Frontend EC2, NAT GW |
| Public | us-east-1b | `10.0.2.0/24` | External ALB, Frontend EC2, NAT GW |
| Private | us-east-1a | `10.0.10.0/24` | Internal ALB, Backend EC2 |
| Private | us-east-1b | `10.0.11.0/24` | Internal ALB, Backend EC2 |

### Routing

- **Public subnets** → Internet Gateway (direct internet access)
- **Private subnets** → NAT Gateway (one per AZ for HA; outbound-only internet)
- **DynamoDB & S3** → VPC Gateway Endpoints (traffic stays within AWS, no NAT cost)

### Load Balancers

#### External ALB (internet-facing)

| Listener | Action |
|----------|--------|
| HTTP :80 | Forward → frontend target group (CloudFront connects here) |
| HTTPS :443 | Forward → frontend target group (direct ALB access uses TLS) |

> CloudFront connects to the External ALB over **HTTP port 80** (origin_protocol_policy = http-only).
> CloudFront enforces HTTPS at the viewer edge so end-users always see HTTPS.

#### Internal ALB (private, path-based routing)

| Priority | Path Pattern | Target Group | Port |
|----------|-------------|--------------|------|
| 10 | `/api/auth/*` | auth-tg | 3001 |
| 20 | `/api/products/*` | product-tg | 3002 |
| 30 | `/api/orders/*` | order-tg | 3003 |
| 40 | `/api/analytics`, `/api/analytics/*` | analytics-tg | 3004 |
| 50 | `/api/assistant`, `/api/assistant/*` | ai-assistant-tg | 3005 |
| default | — | 404 fixed response | — |

### DNS & TLS

- **Route53** hosts the `shopmesh.shop` zone
- **ACM certificate (ALB)** → issued for `shopmesh.shop`, attached to External ALB HTTPS listener
- **ACM certificate (CloudFront)** → issued for `shopmesh.shop` in us-east-1 (CloudFront requirement), attached to CloudFront viewer certificate
- Both certs validated automatically via Route53 DNS CNAME records

### ECR Repositories

| Repository | Image |
|-----------|-------|
| `shopmesh/frontend` | React app + nginx |
| `shopmesh/auth-service` | Node.js auth |
| `shopmesh/product-service` | Node.js products |
| `shopmesh/order-service` | Python orders |
| `shopmesh/analytics-service` | Python analytics + Bedrock |
| `shopmesh/ai-assistant-service` | Python AI assistant + Bedrock |

All repositories: image scanning on push enabled, lifecycle policy keeps last 10 images.

---

## 3. Compute Layer

### Frontend ASG

| Setting | Value |
|---------|-------|
| Subnets | Public (us-east-1a, us-east-1b) |
| AMI | Ubuntu 22.04 LTS (latest, Canonical) |
| Instance type | t3.small |
| Min / Desired / Max | 1 / 2 / 4 |
| Health check | ELB (grace period 300s) |
| Scaling policy | CPU target tracking at 60% |
| Access | No SSH — SSM Session Manager only |
| Public IP | Yes (needed for IGW egress to ECR/SSM) |

**What runs on each frontend EC2:**
- Docker + Docker Compose
- CloudWatch agent (logs + metrics)
- Single container: `shopmesh/frontend:latest` (nginx on port 80)
- nginx serves the React static bundle and proxies `/api/*` to the Internal ALB

### Backend ASG

| Setting | Value |
|---------|-------|
| Subnets | Private (us-east-1a, us-east-1b) |
| AMI | Ubuntu 22.04 LTS (latest, Canonical) |
| Instance type | t3.medium |
| Min / Desired / Max | 1 / 2 / 4 |
| Health check | ELB (grace period 360s) |
| Scaling policies | CPU target tracking at 60% + ALB request count at 1000 req/target |
| Access | No SSH — SSM Session Manager only |
| Public IP | None (private subnet, outbound via NAT Gateway) |

**What runs on each backend EC2:**
- Docker + Docker Compose
- CloudWatch agent (logs + metrics)
- Six containers (all on the same Docker network `shopmesh-backend`):

| Container | Image | Port | Language |
|-----------|-------|------|----------|
| shopmesh-auth | auth-service | 3001 | Node.js |
| shopmesh-products | product-service | 3002 | Node.js |
| shopmesh-orders | order-service | 3003 | Python |
| shopmesh-analytics | analytics-service | 3004 | Python |
| shopmesh-ai-assistant | ai-assistant-service | 3005 | Python |

> All six services co-exist on the same EC2 instance. They communicate with each other via Docker Compose service names (e.g., `http://auth-service:3001`), not via the ALB.

---

## 4. Application Layer — Microservices

### Auth Service (Node.js, port 3001)

**Responsibility:** User registration, login, JWT issuance and validation.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/auth/register` | POST | Register new user (role=user by default) |
| `/api/auth/login` | POST | Login, returns signed JWT |
| `/api/auth/validate` | POST | Validate JWT token (used by other services) |
| `/api/auth/me` | GET | Get current user profile |

**Data:** DynamoDB `shopmesh-users` table  
**JWT:** Signed with secret from Secrets Manager (`shopmesh/jwt-secret`), expires in 24h

---

### Product Service (Node.js, port 3002)

**Responsibility:** Product catalog management, S3 image uploads.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/products/` | GET | No | List/search products (query params: search, category, minPrice, maxPrice) |
| `/api/products/:id` | GET | No | Get product by ID |
| `/api/products/` | POST | Admin | Create product |
| `/api/products/:id` | PUT | Admin | Update product |
| `/api/products/:id` | DELETE | Admin | Delete product |
| `/api/products/:id/upload-url` | POST | Admin | Get S3 presigned URL for image upload |

**Data:** DynamoDB `shopmesh-products` table  
**Storage:** S3 `shopmesh-product-images-*` bucket for product images

---

### Order Service (Python, port 3003)

**Responsibility:** Order creation, status management, SQS/SNS integration.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/orders/` | POST | User | Create order from cart items |
| `/api/orders/` | GET | User | Get current user's orders |
| `/api/orders/:id` | GET | User | Get order by ID |
| `/api/orders/:id/status` | PATCH | Admin | Update order status |

**Data:** DynamoDB `shopmesh-orders` table (GSI on `user_id` for user-specific queries)  
**On order create:** Publishes to SNS `shopmesh-orders` topic → EventBridge → downstream processing  
**Queue:** SQS `shopmesh-order-processing` queue (with DLQ) for async order processing

---

### Analytics Service (Python, port 3004)

**Responsibility:** Business intelligence — inventory forecasting and customer demographics using AI.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/analytics/inventory-forecast` | GET | Admin | AI-powered inventory forecast via Bedrock |
| `/api/analytics/demographics` | GET | Admin | Customer demographics analysis via Bedrock |

**AI:** Amazon Bedrock `InvokeModel` API with `amazon.nova-lite-v1:0`  
**Pattern:** Queries DynamoDB directly for aggregated data, sends to Bedrock, returns structured analysis  
**Access:** Admin-only (JWT role check)

---

### AI Assistant Service (Python, port 3005)

**Responsibility:** Conversational AI shopping assistant using Bedrock's multi-turn tool-use loop.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/assistant/chat` | POST | User | Send message, receive AI response + cart actions |

**Request body:**
```json
{
  "message": "Add 2 USB-C hubs to my cart",
  "conversation_history": [{"role": "user", "content": "..."}],
  "cart_items": [{"product_id": "...", "name": "...", "price": 49.99, "quantity": 1}]
}
```

**Response body:**
```json
{
  "message": "I've added 2x USB-C Hub to your cart.",
  "cart_actions": [{"type": "ADD_TO_CART", "product": {"_id": "...", "quantity": 2}}],
  "timestamp": "2026-06-19T10:45:00Z"
}
```

**AI:** Amazon Bedrock `Converse` API (multi-turn tool use) with `amazon.nova-lite-v1:0`

**9 Tools the AI can call:**

| Tool | Calls | Side Effect |
|------|-------|-------------|
| `search_products` | GET /api/products/ | None |
| `get_product_details` | GET /api/products/:id | None |
| `get_my_orders` | GET /api/orders/ | None |
| `get_order_details` | GET /api/orders/:id | None |
| `get_user_profile` | GET /api/auth/me | None |
| `add_to_cart` | GET /api/products/:id (stock check) | Returns cart_action |
| `remove_from_cart` | None | Returns cart_action |
| `clear_cart` | None | Returns cart_action |
| `place_order` | POST /api/orders/ | Creates order, returns cart_action |

**Key design decisions:**
- Cart is **client-side only** (React CartContext). The AI returns `cart_actions` that the frontend applies — no server-side cart exists.
- Conversation history is **stateless** — the client sends the last 20 messages with every request.
- The JWT token is **forwarded** to order/auth service calls on behalf of the user.
- Tool loop runs up to **10 iterations** before returning a graceful fallback.

---

### Frontend (React + nginx, port 80)

**Responsibility:** Single-page React application + nginx reverse proxy.

**nginx routes:**

| Path | Proxy Target | Read Timeout |
|------|-------------|-------------|
| `/api/auth` | Internal ALB | 30s |
| `/api/products` | Internal ALB | 30s |
| `/api/orders` | Internal ALB | 30s |
| `/api/analytics` | Internal ALB | 60s |
| `/api/assistant` | Internal ALB | 90s (AI tool loop can be slow) |
| `/` | Serve `index.html` (React Router) | — |
| `/static/*` | Static files (1-year cache) | — |
| `/health` | Returns 200 JSON | — |

`INTERNAL_ALB_URL` is injected at container start via `envsubst`.

---

## 5. Data Layer

### DynamoDB Tables

| Table | Primary Key | GSI | Usage |
|-------|------------|-----|-------|
| `shopmesh-users` | `userId` (S) | `email-index` (email → userId) | Auth service |
| `shopmesh-products` | `productId` (S) | None | Product service |
| `shopmesh-orders` | `order_id` (S) | `user_id-index` (user_id → orders) | Order service, analytics |

All tables: PAY_PER_REQUEST billing, point-in-time recovery enabled, server-side encryption enabled.

### S3 Buckets

| Bucket | Purpose |
|--------|---------|
| `shopmesh-product-images-*` | Product images (presigned URL upload from admin) |
| `shopmesh-alb-logs-*` | Access logs from External and Internal ALB |
| `shopmesh-cloudfront-logs-*` | CloudFront access logs |

### Secrets Manager

| Secret | Content |
|--------|---------|
| `shopmesh/jwt-secret` | JWT signing secret used by auth-service |

### VPC Endpoints (cost & security optimisation)

- **DynamoDB Gateway Endpoint** — backend EC2 → DynamoDB bypasses NAT Gateway entirely
- **S3 Gateway Endpoint** — backend EC2 → S3 bypasses NAT Gateway entirely

---

## 6. Messaging Layer

### SNS Topics

| Topic | Subscribers | Trigger |
|-------|------------|---------|
| `shopmesh-orders` | EventBridge rule | Order placed |
| `shopmesh-alerts` | Email (ops@) + CloudWatch alarms | Infra alerts |

### SQS Queues

| Queue | DLQ | Consumer |
|-------|-----|---------|
| `shopmesh-order-processing` | `shopmesh-order-processing-dlq` | Order service (async processing) |

### EventBridge

Consumes from SNS `shopmesh-orders` topic, routes order events to downstream targets (notifications, analytics triggers).

---

## 7. Security Architecture

### IAM Roles

| Role | Principals | Key Permissions |
|------|-----------|----------------|
| `shopmesh-backend-ec2-role` | EC2 instances | DynamoDB (users/products/orders), S3 (product-images), SQS, SNS, Secrets Manager, ECR pull, CloudWatch, Bedrock (InvokeModel + Converse + ConverseStream) |
| `shopmesh-frontend-ec2-role` | EC2 instances | ECR pull, CloudWatch |
| `shopmesh-eventbridge-role` | EventBridge | SNS publish |

All EC2 instances use **SSM Session Manager** for shell access — no SSH keys, port 22 never opened.

### Security Groups

```
Internet
  │ 80, 443
  ▼
[external-alb-sg]  ← allows 0.0.0.0/0 on 80 and 443
  │
  │ 80 only
  ▼
[frontend-sg]      ← allows 80 only FROM external-alb-sg
  │
  │ 80 only
  ▼
[internal-alb-sg]  ← allows 80 only FROM frontend-sg
  │
  │ 3001-3005 from internal-alb-sg
  │ 3001-3005 self (inter-service)
  ▼
[backend-sg]       ← ports 3001-3005 from internal-alb-sg + self
                     all outbound allowed (NAT → AWS APIs)
```

No backend port is ever reachable from the internet. Backend EC2 instances have no public IP.

### Authentication flow

1. Client sends `POST /api/auth/login` with email + password
2. Auth service verifies against DynamoDB, issues JWT signed with Secrets Manager secret
3. Client stores JWT in `localStorage`, sends as `Authorization: Bearer <token>` on every request
4. Each protected backend service calls `POST /api/auth/validate` on the auth service before handling the request
5. AI assistant service additionally extracts the raw token and forwards it in downstream API calls

---

## 8. Observability

### CloudWatch Log Groups

| Log Group | Retention | Source |
|-----------|----------|--------|
| `/shopmesh/auth-service` | 30 days | auth container |
| `/shopmesh/product-service` | 30 days | product container |
| `/shopmesh/order-service` | 30 days | order container |
| `/shopmesh/analytics-service` | 30 days | analytics container |
| `/shopmesh/ai-assistant-service` | 30 days | ai-assistant container |
| `/shopmesh/backend` | 30 days | EC2 userdata bootstrap log |

### CloudWatch Alarms → SNS `shopmesh-alerts`

| Alarm | Threshold | Action |
|-------|----------|--------|
| Frontend CPU | > 70% (2 periods) | SNS alert |
| Backend CPU | > 70% (2 periods) | SNS alert |
| External ALB 5XX errors | > 10 in 5 min | SNS alert |
| Unhealthy targets | > 0 | SNS alert |
| SQS queue depth | > 100 messages | SNS alert |
| DynamoDB user errors | > 5 in 5 min | SNS alert |

### CloudWatch Agent (on every EC2)

Collects per-instance: CPU usage, memory used %, disk used %, and userdata bootstrap log file.

---

## 9. Request Flow — Step by Step

### Flow A: User loads the app (`shopmesh.shop`)

```
1. Browser  ──DNS──►  Route53
                          │  A record (alias)
2.                        ▼
              CloudFront distribution
              [ACM cert for shopmesh.shop]
              viewer_protocol: redirect HTTP→HTTPS
                          │  HTTP :80  (origin_protocol=http-only)
3.                        ▼
              External ALB  (public subnet)
              listener :80 → forward → frontend-tg
                          │  HTTP :80
4.                        ▼
              Frontend EC2  (public subnet)
              Docker: nginx container
              Serves /usr/share/nginx/html/index.html
                          │
5.            Browser renders React app (SPA)
              All subsequent navigation is client-side (React Router)
```

---

### Flow B: User logs in (`POST /api/auth/login`)

```
1. React app
   authAPI.login({email, password})
   → axios POST to "/api/auth/login"  [relative URL]
              │
2.            ▼
   nginx on frontend EC2
   location /api/auth → proxy_pass ${INTERNAL_ALB_URL}/api/auth
              │  HTTP
3.            ▼
   Internal ALB  (private subnet)
   listener :80, rule priority=10
   path /api/auth/* → auth target group (port 3001)
              │
4.            ▼
   Backend EC2  (private subnet)
   Docker: auth-service container :3001
   → validates input
   → queries DynamoDB shopmesh-users (via VPC endpoint, no NAT)
   → signs JWT with secret from Secrets Manager
   → returns { token, user }
              │
5.            ▼
   React stores token in localStorage
   Navbar shows user name + role
```

---

### Flow C: User browses products (`GET /api/products/`)

```
1. React productAPI.getAll({ category: "Electronics", maxPrice: 100 })
   → GET "/api/products/?category=Electronics&maxPrice=100"
              │
2.            ▼
   nginx → proxy_pass Internal ALB /api/products
              │
3.            ▼
   Internal ALB → product target group (port 3002)
              │
4.            ▼
   Backend EC2: product-service :3002
   → queries DynamoDB shopmesh-products (via VPC endpoint)
   → filters by category / price in application layer
   → returns product list
              │
5.            ▼
   React renders product cards
```

---

### Flow D: User places an order (`POST /api/orders/`)

```
1. React orderAPI.create({ items, shipping_address })
   + Authorization: Bearer <JWT>
              │
2.            ▼
   nginx → Internal ALB → order target group (port 3003)
              │
3.            ▼
   Backend EC2: order-service :3003
   → calls auth-service :3001 /api/auth/validate (internal Docker network)
   → validates stock with product-service :3002 (internal Docker network)
   → writes order to DynamoDB shopmesh-orders (via VPC endpoint)
   → publishes to SNS shopmesh-orders topic (via NAT Gateway)
   → sends to SQS shopmesh-order-processing (via NAT Gateway)
   → returns { order_id, status, total_amount }
              │
4.            ▼
   SNS → EventBridge rule → downstream processing
   SQS → async order fulfillment consumer
```

---

### Flow E: AI Assistant chat (`POST /api/assistant/chat`)

```
1. React ChatWidget
   assistantAPI.chat({ message, conversation_history, cart_items })
   + Authorization: Bearer <JWT>
   → POST "/api/assistant/chat"
              │
2.            ▼
   nginx (90s timeout) → Internal ALB → ai-assistant target group (port 3005)
              │
3.            ▼
   Backend EC2: ai-assistant-service :3005
   → require_auth: calls auth-service :3001 /api/auth/validate
                   extracts { user, token }
              │
4.            ▼
   bedrock_service.run_assistant():
   Builds system prompt:
     - Embeds user name, gender, age
     - Embeds current cart summary (from request body)
     - Lists capabilities
              │
5.            ▼
   Bedrock Converse API — amazon.nova-lite-v1:0
   (boto3 call via asyncio.run_in_executor to avoid blocking FastAPI event loop)
              │
6.    ┌── Bedrock responds with stopReason="tool_use" ──────────────────────┐
      │                                                                       │
      │  Tool dispatcher (up to 10 iterations):                              │
      │                                                                       │
      │  search_products  → GET product-service :3002 /api/products/         │
      │  get_product_details → GET product-service :3002 /api/products/:id   │
      │  add_to_cart      → GET product-service :3002 /api/products/:id      │
      │                     (stock check) → returns cart_action              │
      │  get_my_orders    → GET order-service :3003 /api/orders/             │
      │                     (with forwarded Bearer token)                    │
      │  place_order      → POST order-service :3003 /api/orders/            │
      │                     (with forwarded Bearer token + cart_items)       │
      │                                                                       │
      │  Tool results are appended as "user" message, loop continues         │
      └───────────────────────────────────────────────────────────────────────┘
              │
7.            ▼
   Bedrock responds with stopReason="end_turn"
   Returns: { message: "...", cart_actions: [...] }
              │
8.            ▼
   React ChatWidget receives response:
   - Displays AI message in chat bubble
   - Executes cart_actions via CartContext:
       ADD_TO_CART     → addToCart(product)  [uses product.quantity]
       REMOVE_FROM_CART → removeFromCart(product_id)
       CLEAR_CART      → clearCart()
       ORDER_PLACED    → clearCart()
   - Cart badge + modal update in real time
```

---

### Flow F: Admin views analytics

```
1. React analyticsAPI.getInventoryForecast()
   + Authorization: Bearer <JWT with role=admin>
              │
2.            ▼
   nginx → Internal ALB → analytics target group (port 3004)
              │
3.            ▼
   Backend EC2: analytics-service :3004
   → calls auth-service :3001 /api/auth/validate
   → checks role == "admin" (403 if not)
   → scans DynamoDB shopmesh-products, shopmesh-orders (via VPC endpoint)
   → builds prompt from aggregated data
   → calls Bedrock InvokeModel (amazon.nova-lite-v1:0)
   → parses response, returns structured forecast JSON
              │
4.            ▼
   React Admin page renders charts / forecast data
```

---

## 10. Local Development vs Production

| Concern | Local (Docker Compose) | Production (AWS) |
|---------|----------------------|-----------------|
| Frontend URL | `http://localhost:3000` | `https://shopmesh.shop` |
| API routing | Direct localhost ports | nginx → Internal ALB |
| Database | DynamoDB Local (in-memory) | AWS DynamoDB |
| Auth | Local JWT secret in env | Secrets Manager |
| Bedrock | Disabled (`LOCAL_MODE=true`) | Enabled (`LOCAL_MODE=false`) |
| Storage | No S3 | S3 via VPC endpoint |
| Messaging | No SQS/SNS | SQS + SNS |
| Container images | Built locally via `docker-compose build` | Pulled from ECR |
| EC2 access | N/A | SSM Session Manager (no SSH) |
| TLS | None | ACM + CloudFront + ALB |

### Environment Variables that switch behaviour

| Variable | `true` (local) | `false` (production) |
|----------|---------------|---------------------|
| `LOCAL_MODE` | Mock Bedrock, use DynamoDB Local endpoint | Real Bedrock, real DynamoDB |
| `BEDROCK_MODEL_ID` | Unused | `amazon.nova-lite-v1:0` |
| `DYNAMODB_ENDPOINT` | `http://dynamodb-local:8000` | Not set (AWS SDK auto-resolves) |
