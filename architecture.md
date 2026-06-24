# ShopMesh — Architecture Diagrams

---

## 1. Infrastructure Architecture

```
                              ┌─────────────────────────────────────────┐
                              │           USERS (Global Internet)        │
                              └────────────────────┬────────────────────┘
                                                   │ HTTPS (TLS 1.2+)
                                                   ▼
                              ┌─────────────────────────────────────────┐
                              │           ROUTE 53                       │
                              │   Hosted Zone: shopmesh.shop             │
                              │   A alias → CloudFront                   │
                              │   ACM CNAME validation records           │
                              └────────────────────┬────────────────────┘
                                                   │
                                                   ▼
                    ┌──────────────────────────────────────────────────────┐
                    │             CLOUDFRONT  (E1N9Y9KYLN4Q4I)             │
                    │                                                        │
                    │  ACM Certificate: *.shopmesh.shop (us-east-1)        │
                    │                                                        │
                    │  Cache Behaviors (ordered):                           │
                    │  ┌───────────────────────────────────────────────┐   │
                    │  │ /grafana*  → cookies: ALL, headers: ALL        │   │
                    │  │            → no cache, all HTTP methods        │   │
                    │  │ /api/*     → cookies: ALL, headers: ALL        │   │
                    │  │            → no cache, all HTTP methods        │   │
                    │  │ /static/*  → cookies: none → cache 1yr        │   │
                    │  │ default    → no cache, limited headers         │   │
                    │  └───────────────────────────────────────────────┘   │
                    │  Origin: ALB (HTTP port 80, http-only protocol)       │
                    └───────────────────────┬──────────────────────────────┘
                                            │ HTTP → origin
                                            │
┌───────────────────────────────────────────▼────────────────────────────────────────────────┐
│                              AWS REGION: us-east-1                                          │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                    VPC: shopmesh-prod-vpc  (10.0.0.0/16)                              │  │
│  │                    Internet Gateway ← attached to VPC                                 │  │
│  │                                                                                        │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │              PUBLIC SUBNETS  (internet-reachable, IGW route)                    │  │  │
│  │  │                                                                                  │  │  │
│  │  │  us-east-1a  10.0.1.0/24              us-east-1b  10.0.2.0/24                 │  │  │
│  │  │  ┌──────────────────────┐             ┌──────────────────────┐                 │  │  │
│  │  │  │   NAT Gateway 1a     │             │   NAT Gateway 1b     │                 │  │  │
│  │  │  │   (EIP attached)     │             │   (EIP attached)     │                 │  │  │
│  │  │  └──────────┬───────────┘             └──────────┬───────────┘                 │  │  │
│  │  │             │ outbound for                        │ outbound for                 │  │  │
│  │  │             │ private-1a pods                     │ private-1b pods              │  │  │
│  │  │             │                                     │                              │  │  │
│  │  │  ┌──────────▼─────────────────────────────────────▼────────────────────────┐   │  │  │
│  │  │  │          APPLICATION LOAD BALANCER (shopmesh-external-alb)               │   │  │  │
│  │  │  │          SG: shopmesh-alb-sg  (inbound 80 + 443 from 0.0.0.0/0)         │   │  │  │
│  │  │  │                                                                           │   │  │  │
│  │  │  │  Listener :80 (HTTP)                 Listener :443 (HTTPS)               │   │  │  │
│  │  │  │  ┌──────────────────────────────┐   ┌──────────────────────────────────┐│   │  │  │
│  │  │  │  │ Rule priority 100:            │   │ Rule priority 100:               ││   │  │  │
│  │  │  │  │  path = /grafana             │   │  path = /grafana                ││   │  │  │
│  │  │  │  │  path = /grafana/*           │   │  path = /grafana/*              ││   │  │  │
│  │  │  │  │  → shopmesh-grafana-tg       │   │  → shopmesh-grafana-tg          ││   │  │  │
│  │  │  │  │ Default:                     │   │ Default:                        ││   │  │  │
│  │  │  │  │  → shopmesh-frontend-tg      │   │  → shopmesh-frontend-tg         ││   │  │  │
│  │  │  │  └──────────────────────────────┘   └──────────────────────────────────┘│   │  │  │
│  │  │  └───────────────────────────────────────────────────────────────────────────┘   │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────────┘  │  │
│  │                           │  (ip-mode targets registered by ALBC)                     │  │
│  │  ┌────────────────────────▼───────────────────────────────────────────────────────┐  │  │
│  │  │              PRIVATE SUBNETS  (no IGW route — egress via NAT only)              │  │  │
│  │  │                                                                                  │  │  │
│  │  │   us-east-1a  10.0.10.0/24               us-east-1b  10.0.11.0/24             │  │  │
│  │  │   ┌────────────────────────────┐         ┌────────────────────────────┐        │  │  │
│  │  │   │  EKS Worker Node           │         │  EKS Worker Node           │        │  │  │
│  │  │   │  t3.medium (2vCPU/4GB)     │         │  t3.medium (2vCPU/4GB)     │        │  │  │
│  │  │   │  max 17 pods               │         │  max 17 pods               │        │  │  │
│  │  │   │  50GB EBS root vol         │         │  50GB EBS root vol         │        │  │  │
│  │  │   └────────────────────────────┘         └────────────────────────────┘        │  │  │
│  │  │   ┌────────────────────────────┐         ┌────────────────────────────┐        │  │  │
│  │  │   │  EKS Worker Node           │         │  EKS Worker Node           │        │  │  │
│  │  │   │  t3.medium (2vCPU/4GB)     │         │  t3.medium (2vCPU/4GB)     │        │  │  │
│  │  │   │  max 17 pods               │         │  max 17 pods               │        │  │  │
│  │  │   │  50GB EBS root vol         │         │  50GB EBS root vol         │        │  │  │
│  │  │   └────────────────────────────┘         └────────────────────────────┘        │  │  │
│  │  │   (4 nodes total: desired=4, min=2, max=6 · 68 total pod slots)                │  │  │
│  │  │                                                                                  │  │  │
│  │  │   ┌────────────────────────────────────────────────────────────────┐           │  │  │
│  │  │   │  EKS CONTROL PLANE  (AWS Managed — shopmesh-prod v1.30)        │           │  │  │
│  │  │   │  API Server · Scheduler · Controller Manager · etcd            │           │  │  │
│  │  │   │  OIDC Provider: oidc.eks.us-east-1.amazonaws.com/id/31C1...    │           │  │  │
│  │  │   │  Logs → CloudWatch: /aws/eks/shopmesh-prod/cluster             │           │  │  │
│  │  │   └────────────────────────────────────────────────────────────────┘           │  │  │
│  │  │                                                                                  │  │  │
│  │  │   ┌────────────────────────────────────────────────────────────────┐           │  │  │
│  │  │   │  VPC ENDPOINTS (private — no internet, no NAT cost)             │           │  │  │
│  │  │   │  • com.amazonaws.us-east-1.dynamodb  (Gateway type)            │           │  │  │
│  │  │   │  • com.amazonaws.us-east-1.s3        (Gateway type)            │           │  │  │
│  │  │   └────────────────────────────────────────────────────────────────┘           │  │  │
│  │  └────────────────────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                              │
│   AWS MANAGED SERVICES (outside VPC — accessed via IRSA or VPC Endpoints)                   │
│   ┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────────┐  │
│   │  DYNAMODB             │   │  S3                  │   │  SQS + SNS + EVENTBRIDGE     │  │
│   │  shopmesh-users       │   │  shopmesh-product-   │   │  shopmesh-order-processing   │  │
│   │  shopmesh-products    │   │  images-242969680553  │   │  (queue + DLQ)               │  │
│   │  shopmesh-orders      │   │  (product images)    │   │  shopmesh-orders (topic)     │  │
│   │  on-demand billing    │   │  ALB + CF log buckets│   │  shopmesh-alerts (topic)     │  │
│   └──────────────────────┘   └──────────────────────┘   │  EventBridge rules           │  │
│                                                           └──────────────────────────────┘  │
│   ┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────────┐  │
│   │  SECRETS MANAGER     │   │  ECR (6 repos)        │   │  CLOUDWATCH                 │  │
│   │  shopmesh/jwt-secret │   │  shopmesh/frontend    │   │  /shopmesh/eks (logs)        │  │
│   │  (JWT signing key)   │   │  shopmesh/auth-svc    │   │  /aws/eks/shopmesh-prod/     │  │
│   │                      │   │  shopmesh/product-svc │   │  cluster (control plane)     │  │
│   │                      │   │  shopmesh/order-svc   │   │  Container Insights metrics  │  │
│   │                      │   │  shopmesh/analytics   │   │  Custom alarms               │  │
│   │                      │   │  shopmesh/ai-assistant│   └──────────────────────────────┘  │
│   └──────────────────────┘   └──────────────────────┘                                      │
│                                                                                              │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐   │
│   │  IAM (IRSA — 11 roles + 2 GitHub Actions roles)                                    │   │
│   │  OIDC trust: EKS cluster ↔ IAM for pod credentials                                │   │
│   │  OIDC trust: github.com ↔ IAM for CI/CD credentials                               │   │
│   └────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
          │  cross-account STS AssumeRole
          ▼
┌─────────────────────────────┐
│  AWS ACCOUNT: 686591366739  │
│  Amazon Bedrock             │
│  Model: nova-lite-v1:0      │
│  (AI shopping assistant)    │
└─────────────────────────────┘
```

---

## 2. Application Architecture

```
╔══════════════════════════════════════════════════════════════════════════════════════════════╗
║                        TECH STACK PER SERVICE                                               ║
╠═══════════════════════╦══════════════════════════════════════════════════════════════════════╣
║ Service               ║ Language · Framework · Key Libraries                                ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ frontend              ║ React 18 · React Router v6 · Axios · react-hot-toast                ║
║                       ║ Served by nginx (envsubst injects INTERNAL_ALB_URL at start)        ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ auth-service          ║ Node.js · Express 4 · jsonwebtoken · bcryptjs                       ║
║                       ║ express-validator · helmet · AWS SDK v3 (DynamoDB, SecretsManager)  ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ product-service       ║ Node.js · Express 4 · AWS SDK v3 (DynamoDB, S3, SNS, SecretsManager)║
║                       ║ s3-request-presigner (signed URLs for image upload/download)        ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ order-service         ║ Python · FastAPI · Pydantic · boto3                                 ║
║                       ║ Saga pattern: atomic stock decrement + rollback on failure           ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ analytics-service     ║ Python · FastAPI · boto3 (DynamoDB, CloudWatch)                     ║
╠═══════════════════════╬══════════════════════════════════════════════════════════════════════╣
║ ai-assistant-service  ║ Python · FastAPI · Pydantic · boto3 (Bedrock cross-account)         ║
║                       ║ Converse API · supports cart_actions (add/remove from cart)         ║
╚═══════════════════════╩══════════════════════════════════════════════════════════════════════╝

──────────────────────────────────────────────────────────────────────────────────────────────
                         REQUEST FLOW  (browser → database → back)
──────────────────────────────────────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │                      USER'S BROWSER                                                   │
  │  React 18 SPA                                                                         │
  │  Pages: Home · Products · Orders · Analytics · AI Chat · Login · Register            │
  │  State: React Context (Auth, Cart)  │  HTTP client: Axios                            │
  │  Routing: React Router v6 (client-side, no full page reloads)                        │
  └────────────────────────────┬─────────────────────────────────────────────────────────┘
                               │ HTTPS — shopmesh.shop
                               │ (CloudFront → ALB → TGB → pod IP:80)
                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  FRONTEND POD  (nginx, port 80, ×2 replicas)                                         │
  │  ECR: 242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/frontend:40ddaf5         │
  │                                                                                      │
  │  nginx has TWO jobs:                                                                 │
  │  ① Serve React build files from /usr/share/nginx/html/                               │
  │     location / { try_files $uri $uri/ /index.html; }  ← SPA fallback                │
  │     location ~* \.(js|css|png|svg|woff2)$ { expires 1y; }  ← static cache          │
  │     location = /index.html { Cache-Control: no-cache; }  ← always fresh             │
  │                                                                                      │
  │  ② Proxy all /api/* and /grafana paths to kgateway (internal cluster DNS):           │
  │     location /api/auth      → proxy_pass http://prod.kgateway-system.svc...:80      │
  │     location /api/products  → proxy_pass http://prod.kgateway-system.svc...:80      │
  │     location /api/orders    → proxy_pass http://prod.kgateway-system.svc...:80      │
  │     location /api/analytics → proxy_pass http://prod.kgateway-system.svc...:80      │
  │     location /api/assistant → proxy_pass http://prod.kgateway-system.svc...:80      │
  │     (timeout: auth/products/orders 30s · analytics 60s · assistant 90s)             │
  │                                                                                      │
  │  ③ Health check: GET /health → 200 {"status":"OK","service":"frontend"}              │
  └────────────────────────────┬─────────────────────────────────────────────────────────┘
                               │ HTTP, Kubernetes internal DNS
                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  KGATEWAY  (Envoy Proxy — kgateway-system namespace)                                 │
  │  DNS: prod.kgateway-system.svc.cluster.local:80                                     │
  │                                                                                      │
  │  Reads HTTPRoute CRDs — routes by PathPrefix (longest match wins):                  │
  │                                                                                      │
  │  Path               Backend Service                           Port                  │
  │  ─────────────────────────────────────────────────────────────────                  │
  │  /api/auth      →  auth-service.production.svc.cluster.local  :3001                │
  │  /api/products  →  product-service.production.svc.cluster.local :3002              │
  │  /api/orders    →  order-service.production.svc.cluster.local  :3003               │
  │  /api/analytics →  analytics-service.production.svc.cluster.local :3004            │
  │  /api/assistant →  ai-assistant-service.production.svc.cluster.local :3005         │
  │  /grafana       →  monitoring-grafana.monitoring.svc.cluster.local :80              │
  │                     (cross-namespace via ReferenceGrant)                            │
  │  /              →  frontend.production.svc.cluster.local :80                       │
  └────────┬────────────┬────────────┬────────────┬────────────┬────────────────────────┘
           │            │            │            │            │
           ▼            ▼            ▼            ▼            ▼
──────────────────────────────────────────────────────────────────────────────────────────────
                         MICROSERVICES (namespace: production)
──────────────────────────────────────────────────────────────────────────────────────────────

  ┌────────────────────────────────────┐
  │  AUTH-SERVICE  :3001  (Node.js)     │
  │  ×2 pods  HPA 2→6                  │
  │                                    │
  │  API Endpoints:                    │
  │  POST /api/auth/register           │
  │    body: {name,email,password,     │
  │           gender,age}              │
  │    bcryptjs hash → DynamoDB write  │
  │    returns: JWT token              │
  │                                    │
  │  POST /api/auth/login              │
  │    bcryptjs.compare(pw, hash)      │
  │    returns: JWT (24h expiry)       │
  │                                    │
  │  GET  /api/auth/me                 │
  │    reads JWT from Authorization    │
  │    header → returns user profile   │
  │                                    │
  │  POST /api/auth/validate           │
  │    body: {token}                   │
  │    jwt.verify(token, JWT_SECRET)   │
  │    returns: {valid:true, user:{}}  │
  │    ← called by ALL other services  │
  │                                    │
  │  AWS (IRSA):                       │
  │  → DynamoDB: shopmesh-users        │
  │    GetItem · PutItem · Query       │
  │  → SecretsManager: jwt-secret      │
  │    (loaded at startup into         │
  │     process.env.JWT_SECRET)        │
  │                                    │
  │  Secret: JWT_SECRET                │
  │  via ExternalSecret → ESO →        │
  │  Secrets Manager                   │
  └────────────────────────────────────┘

  ┌────────────────────────────────────┐
  │  PRODUCT-SERVICE  :3002 (Node.js)  │
  │  ×2 pods  HPA 2→6                  │
  │                                    │
  │  API Endpoints:                    │
  │  GET  /api/products                │
  │    Query DynamoDB shopmesh-products│
  │    Returns list with S3 image URLs │
  │    (pre-signed URLs via SDK)       │
  │                                    │
  │  POST /api/products                │
  │    (admin only — JWT role check)   │
  │    Writes to DynamoDB              │
  │    Publishes SNS: product.created  │
  │                                    │
  │  GET  /api/products/:id            │
  │  PATCH /api/products/:id/stock     │
  │    ← called by order-service       │
  │    Decrements stock count          │
  │                                    │
  │  AWS (IRSA):                       │
  │  → DynamoDB: shopmesh-products     │
  │  → S3: shopmesh-product-images-..  │
  │    GetObject, PutObject            │
  │    s3-request-presigner            │
  │  → SNS: shopmesh-orders (publish)  │
  │                                    │
  │  Calls auth-service:               │
  │  POST /api/auth/validate (JWT)     │
  └────────────────────────────────────┘

  ┌────────────────────────────────────┐
  │  ORDER-SERVICE  :3003  (Python)    │
  │  FastAPI · Pydantic                │
  │  ×2 pods  HPA 2→6                  │
  │                                    │
  │  API Endpoints:                    │
  │  POST /api/orders                  │
  │    SAGA PATTERN:                   │
  │    1. Validate JWT via auth-svc    │
  │    2. GET product details          │
  │       (product-service)            │
  │    3. Check stock per item         │
  │    4. Decrement stock atomically   │
  │       PATCH .../stock (product-svc)│
  │    5. If any fail → ROLLBACK       │
  │       restore_product_stock()      │
  │    6. Write order to DynamoDB      │
  │    7. SQS: send order event        │
  │    8. SNS: notify_order_created    │
  │                                    │
  │  GET /api/orders                   │
  │    DynamoDB query by userId        │
  │  GET /api/orders/{id}              │
  │  PATCH /api/orders/{id}/status     │
  │    SNS: notify_order_status_changed│
  │                                    │
  │  AWS (IRSA):                       │
  │  → DynamoDB: shopmesh-orders       │
  │  → SQS: shopmesh-order-processing  │
  │  → SNS: shopmesh-orders            │
  │          shopmesh-alerts           │
  │                                    │
  │  Calls:                            │
  │  → auth-service:3001 /validate     │
  │  → product-service:3002            │
  │    GET /products/:id               │
  │    PATCH /products/:id/stock       │
  └────────────────────────────────────┘

  ┌────────────────────────────────────┐
  │  ANALYTICS-SERVICE :3004 (Python)  │
  │  FastAPI · boto3                   │
  │  ×2 pods  HPA 2→6                  │
  │                                    │
  │  API Endpoints:                    │
  │  GET /api/analytics/summary        │
  │    Aggregates from DynamoDB:       │
  │    - Orders: total count, revenue  │
  │    - Products: top sellers         │
  │    - Users: active buyers          │
  │                                    │
  │  GET /api/analytics/orders         │
  │  GET /api/analytics/products       │
  │                                    │
  │  AWS (IRSA):                       │
  │  → DynamoDB (read-only):           │
  │    shopmesh-orders (Query/Scan)    │
  │    shopmesh-products (Query/Scan)  │
  │    shopmesh-users (Query/Scan)     │
  │  → CloudWatch: PutMetricData       │
  │    (custom business metrics)       │
  │                                    │
  │  Calls:                            │
  │  → auth-service:3001 /validate     │
  └────────────────────────────────────┘

  ┌────────────────────────────────────┐
  │  AI-ASSISTANT :3005  (Python)      │
  │  FastAPI · Pydantic · boto3        │
  │  ×2 pods  HPA 2→6                  │
  │                                    │
  │  API Endpoint:                     │
  │  POST /api/assistant/chat          │
  │    body: {                         │
  │      message: string,              │
  │      conversation_history: [...],  │
  │      cart_items: [...]             │
  │    }                               │
  │    response: {                     │
  │      message: string,              │
  │      cart_actions: [...],  ← NEW   │
  │      timestamp: string             │
  │    }                               │
  │                                    │
  │  cart_actions let the frontend     │
  │  add/remove items from CartContext │
  │  without the user clicking         │
  │                                    │
  │  AWS (IRSA):                       │
  │  → STS: AssumeRole cross-account   │
  │    686591366739:role/shopmesh-     │
  │    bedrock-cross-account           │
  │  → Bedrock Converse API:           │
  │    amazon.nova-lite-v1:0           │
  │                                    │
  │  Calls (for context building):     │
  │  → auth-service:3001 /validate     │
  │  → product-service:3002 /products  │
  │  → order-service:3003 /orders      │
  └────────────────────────────────────┘

──────────────────────────────────────────────────────────────────────────────────────────────
                         SERVICE-TO-SERVICE CALL MAP
──────────────────────────────────────────────────────────────────────────────────────────────

                        ┌─────────────────┐
                        │  AUTH-SERVICE    │
                        │  :3001           │
                        │  POST /validate  │
                        └────────┬────────┘
                                 │ called by ALL services
              ┌──────────────────┼──────────────────┬──────────────────┐
              │                  │                  │                  │
              ▼                  ▼                  ▼                  ▼
  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
  │ PRODUCT-SERVICE  │ │  ORDER-SERVICE   │ │ANALYTICS-SERVICE │ │ AI-ASSISTANT     │
  │ :3002            │ │  :3003           │ │ :3004            │ │ :3005            │
  └──────────────────┘ └────────┬─────────┘ └──────────────────┘ └────────┬─────────┘
           ▲                    │                                           │
           │   PATCH /stock     │ GET /products/:id                        │ GET /products
           └────────────────────┘ PATCH /products/:id/stock                │ GET /orders
                                                                            └────────────►
                                                                           product-svc:3002
                                                                           order-svc:3003

──────────────────────────────────────────────────────────────────────────────────────────────
                         DATA LAYER  (what each service reads/writes)
──────────────────────────────────────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AWS DYNAMODB  (on-demand billing, VPC endpoint — no NAT cost)                        │
  │                                                                                      │
  │  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────┐  │
  │  │  shopmesh-users          │  │  shopmesh-products       │  │  shopmesh-orders    │  │
  │  │  PK: userId (uuid)       │  │  PK: productId (uuid)    │  │  PK: orderId (uuid) │  │
  │  │                          │  │                          │  │                     │  │
  │  │  Fields:                 │  │  Fields:                 │  │  Fields:            │  │
  │  │  name, email,            │  │  name, description,      │  │  userId, userEmail, │  │
  │  │  passwordHash (bcrypt),  │  │  price, stock,           │  │  items[], total,    │  │
  │  │  role, gender, age,      │  │  category, imageUrl,     │  │  status, shipping,  │  │
  │  │  createdAt               │  │  createdAt               │  │  createdAt          │  │
  │  │                          │  │                          │  │                     │  │
  │  │  Written by: auth-svc    │  │  Written by: product-svc │  │  Written by:        │  │
  │  │  Read by: auth-svc,      │  │  Read by: product-svc,   │  │  order-svc          │  │
  │  │           analytics-svc  │  │  order-svc,              │  │  Read by:           │  │
  │  └─────────────────────────┘  │  analytics-svc,           │  │  order-svc,         │  │
  │                                │  ai-assistant-svc         │  │  analytics-svc,     │  │
  │                                └─────────────────────────┘  │  ai-assistant-svc   │  │
  │                                                               └─────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AWS S3  (VPC endpoint — private)                                                    │
  │  Bucket: shopmesh-product-images-242969680553                                        │
  │  Written by: product-service  (PutObject — image upload)                            │
  │  Read by:    product-service  (GetObject / pre-signed URL for browser download)      │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AWS SQS  (async order processing)                                                   │
  │  Queue: shopmesh-order-processing   DLQ: shopmesh-order-processing-dlq               │
  │  Written by: order-service  (SendMessage after every order created)                  │
  │  Consumed by: SQS workers inside order-service (app/workers/)                        │
  │  DLQ: messages that fail 3× processing attempts land here for manual inspection      │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AWS SNS  (pub/sub event broadcasting)                                               │
  │  Topic: shopmesh-orders  → order-service publishes on create + status change         │
  │  Topic: shopmesh-alerts  → order-service publishes high-value order alerts           │
  │  EventBridge rule: routes SNS events conditionally to alert subscribers             │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AWS SECRETS MANAGER  →  EXTERNAL SECRETS OPERATOR  →  Kubernetes Secret            │
  │                                                                                      │
  │  shopmesh/jwt-secret  {"jwt_secret":"..."}                                           │
  │         │  ESO polls every 1h via IRSA                                               │
  │         ▼                                                                            │
  │  Kubernetes Secret "auth-service-secret"    → JWT_SECRET env var  (auth-svc)        │
  │  Kubernetes Secret "product-service-secret" → JWT_SECRET env var  (product-svc)     │
  └──────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │  AMAZON BEDROCK  (cross-account: 686591366739)                                       │
  │  Model: amazon.nova-lite-v1:0                                                        │
  │  ai-assistant-service → STS AssumeRole → Bedrock Converse API                       │
  │  Input: user message + conversation history + current cart + product/order context   │
  │  Output: AI response text + cart_actions[] (add/remove items from user's cart)       │
  └──────────────────────────────────────────────────────────────────────────────────────┘

──────────────────────────────────────────────────────────────────────────────────────────────
                         COMPLETE REQUEST TRACE  (user places an order)
──────────────────────────────────────────────────────────────────────────────────────────────

  Step 1   Browser: POST https://shopmesh.shop/api/orders
           Headers: Authorization: Bearer <JWT>
           Body: { items: [{productId:"p1", quantity:2}], shippingAddress:{...} }

  Step 2   CloudFront: path=/api/orders matches /api/* behavior
           → cookies:ALL, headers:ALL, no cache
           → forward to ALB (HTTP)

  Step 3   ALB: no /grafana match → default rule → shopmesh-frontend-tg
           → ALBC registered pod IP: 10.0.11.62:80

  Step 4   nginx (frontend pod):
           location /api/orders { proxy_pass http://prod.kgateway-system.svc...:80; }

  Step 5   kgateway (Envoy):
           PathPrefix /api/orders → order-service.production.svc.cluster.local:3003

  Step 6   order-service (Python FastAPI):
           a. GET auth-service:3001/api/auth/validate  (JWT check)
              ← {valid:true, user:{userId:"u1", email:"x@y.com"}}
           b. GET product-service:3002/api/products/p1  (fetch details + price)
              ← {name:"Nike Shoes", price:89.99, stock:15}
           c. PATCH product-service:3002/api/products/p1/stock  (decrement by 2)
              ← stock updated atomically; rollback queued if next step fails
           d. DynamoDB PutItem → shopmesh-orders  (orderId, userId, items, total:$179.98)
           e. SQS SendMessage → shopmesh-order-processing  (async downstream processing)
           f. SNS Publish → shopmesh-orders  (event: ORDER_CREATED)

  Step 7   SNS → EventBridge:
           Rule: amount > $100 → publish to shopmesh-alerts
           (In production: email notification to operations team)

  Step 8   Response: 201 Created { orderId:"o789", status:"pending", total:179.98 }
           ← order-service → kgateway → nginx → ALB → CloudFront → Browser

  Step 9   Browser: React updates order history page via re-fetch
           Notification: react-hot-toast "Order placed successfully!"
```

---

## 3. Terraform Module Dependency Chain

```
  terraform.tfvars  (project_name, domain_name, eks_node_desired_size=4, ...)
         │
         ▼
  main.tf (root)
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  │  github-oidc.tf ──────────────────────────────────────────────── (standalone)
  │    aws_iam_openid_connect_provider.github_actions                           │
  │    aws_iam_role.github_actions  (ECR push)                                 │
  │    aws_iam_role.terraform_ci    (AdministratorAccess)                      │
  │                                                                              │
  │  module.vpc ──────────────────────────────────────────────────── LAYER 1    │
  │    outputs: vpc_id, public_subnet_ids, private_subnet_ids                  │
  │         │                                                                   │
  │         ▼                                                                   │
  │  module.security_groups ─────────────────────────────────────── LAYER 2    │
  │    input:  vpc_id                                                           │
  │    output: external_alb_sg_id                                              │
  │         │                                                                   │
  │         ▼                                                                   │
  │  module.eks ─────────────────────────────────────────────────── LAYER 3    │
  │    input:  private_subnet_ids, public_subnet_ids                           │
  │    output: oidc_provider_arn, cluster_oidc_issuer_url,                    │
  │            cluster_endpoint, cluster_sg_id                                │
  │         │                                                                   │
  │         ├──────────────────────────────────────────────────────┐           │
  │         ▼                                                        ▼          │
  │  module.irsa ──────────────────────────── LAYER 4     aws_eks_addon.*      │
  │    input:  oidc_provider_arn,                         (ebs-csi needs       │
  │            oidc_issuer_url                             irsa ebs role)      │
  │    output: 11 role ARNs                                                    │
  │         │                                                                   │
  │         ▼                                                                   │
  │  module.alb ─────────────────────────────────────────────────── LAYER 5    │
  │    input:  vpc_id, public_subnet_ids,                                      │
  │            alb_sg_id, acm cert ARN                                        │
  │    output: external_alb_dns_name,                                          │
  │            frontend_target_group_arn,                                      │
  │            grafana_target_group_arn                                        │
  │         │                                                                   │
  │         ├── aws_security_group_rule.alb_to_pods                           │
  │         │     (alb_sg → eks cluster_sg, port 80)                          │
  │         ├── aws_security_group_rule.alb_to_grafana                        │
  │         │     (alb_sg → eks cluster_sg, port 3000)                        │
  │         ▼                                                                   │
  │  module.cloudfront ──────────────────────────────────────────── LAYER 6    │
  │    input:  external_alb_dns_name                                           │
  │    output: cloudfront_domain_name, cloudfront_distribution_id             │
  │         │                                                                   │
  │         ▼                                                                   │
  │  module.route53 ─────────────────────────────────────────────── LAYER 7    │
  │    input:  cloudfront_domain_name                                          │
  │    Creates: A alias record → CloudFront                                    │
  │             ACM DNS validation CNAMEs                                      │
  │                                                                              │
  │  Parallel (independent of above chain):                                     │
  │  module.dynamodb  module.s3  module.sqs  module.sns                        │
  │  module.secretsmanager  module.ecr  module.cloudwatch  module.eventbridge  │
  │                                                                              │
  │  Remote state: s3://shopmesh-terraform-state-242969680553/shopmesh/        │
  │  State lock:   DynamoDB table shopmesh-terraform-locks                     │
  └─────────────────────────────────────────────────────────────────────────────┘
```

---

*Account: 242969680553 · Region: us-east-1 · Cluster: shopmesh-prod · June 2026*
