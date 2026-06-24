# ShopMesh EKS Capstone — Fixes & Architecture

## What We Fixed

---

### Fix 1: External ALB Could Not Reach Pods (504 on Every Request)

**Problem**

The EKS cluster auto-creates a "cluster security group" when it is provisioned. This SG only has a self-referencing inbound rule — meaning EKS nodes can talk to each other, but nothing from outside can reach pod ENIs. The TargetGroupBinding used `target_type: ip`, which means the ALB connects directly to pod IP addresses (bypassing any node-level NodePort). The ALB's ENIs (in public subnets `10.0.1.x`, `10.0.2.x`) had no inbound rule allowing them into the EKS cluster SG — so every health check timed out, both targets stayed Unhealthy, and every browser request returned 504.

**Fix**

Added an inbound rule to the EKS cluster SG allowing TCP 80 from the ALB security group:

```bash
aws ec2 authorize-security-group-ingress \
  --group-id <EKS-cluster-SG>        \
  --protocol tcp --port 80            \
  --source-group <ALB-SG>             \
  --region us-east-1
```

Codified in Terraform (`aws-terraform/terraform/main.tf`):

```hcl
resource "aws_security_group_rule" "alb_to_pods" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  source_security_group_id = module.security_groups.external_alb_sg_id
  security_group_id        = module.eks.cluster_security_group_id
  description              = "Allow external ALB to reach pods (TargetGroupBinding ip type)"
}
```

Also added the missing output to `aws-terraform/terraform/modules/eks/outputs.tf`:

```hcl
output "cluster_security_group_id" {
  value = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}
```

**Result:** ALB targets flipped Healthy. Frontend returned HTTP 200.

---

### Fix 2: All API Routes Returned 502 — kgateway Name Collision

**Problem**

The kgateway Helm chart was installed with release name `kgateway`. It created a Deployment named `kgateway` (the controller). We also had a Gateway resource named `kgateway` in the same namespace. When the Gateway controller saw a Gateway named `kgateway`, it tried to create/update a proxy Deployment also named `kgateway` — but a Deployment with that name already existed (the controller itself) with a different pod selector. Kubernetes rejected the selector update (immutable field), causing the controller to loop at 3,968+ retries and never produce a proxy pod. The `kgateway` Service had `ENDPOINTS: <none>` because no proxy pod existed. Every API call proxied through nginx got "connection refused" from kgateway → 502.

**Fix**

Renamed the Gateway resource from `kgateway` to `prod` in `shopmesh-gitops/infrastructure/kgateway/gateway.yaml`:

```yaml
metadata:
  name: prod          # was: kgateway
  namespace: kgateway-system
spec:
  gatewayClassName: kgateway
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All
```

Updated all 6 HTTPRoutes to reference the renamed Gateway:

```yaml
parentRefs:
  - name: prod          # was: kgateway
    namespace: kgateway-system
```

Updated the frontend nginx config to proxy to the new `prod` service:

```yaml
# shopmesh-gitops/charts/frontend/values.yaml
config:
  INTERNAL_ALB_URL: "http://prod.kgateway-system.svc.cluster.local:80"
```

**Result:** Controller stopped looping. A separate proxy Deployment named `prod` was created by the controller. The `prod` Service got endpoint `10.0.10.13:80`.

---

### Fix 3: ArgoCD Pruned the kgateway ServiceAccount

**Problem**

`kgateway-app.yaml` had `prune: true` with `ServerSideApply: true`. The kgateway Helm-managed ServiceAccount (`kgateway`) was not in the git path that ArgoCD was syncing, so ArgoCD pruned it. Without its ServiceAccount, the controller pod failed with:

```
unable to load in-cluster config: no serviceaccount token
```

The proxy then crashed with:

```
StreamAggregatedResources: no healthy upstream
```

Because the controller was down and the proxy could not get xDS routes.

**Fix**

Manually recreated the ServiceAccount:

```bash
kubectl create serviceaccount kgateway -n kgateway-system
```

Set `prune: false` on the kgateway ArgoCD Application so it never prunes Helm-managed resources again (`shopmesh-gitops/applications/infrastructure/kgateway-app.yaml`):

```yaml
syncPolicy:
  automated:
    prune: false
    selfHeal: true
```

**Result:** Controller pod recovered. Proxy reconnected to xDS.

---

### Fix 4: kgateway Controller Service Was Deleted

**Problem**

When ArgoCD synced the Gateway rename (deleting the old Gateway resource named `kgateway`), the kgateway controller cleaned up all resources it had created for that Gateway — including a Service also named `kgateway`. But this Service was the same name as the Helm-installed controller Service that the proxy uses to connect to xDS on port 9977. The proxy bootstrap configmap pointed to `kgateway.kgateway-system.svc.cluster.local:9977`. With the Service deleted, the proxy could not reach the controller and crashed with:

```
no healthy upstream
```

**Fix**

Manually recreated the ClusterIP Service:

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: kgateway
  namespace: kgateway-system
spec:
  selector:
    app.kubernetes.io/instance: kgateway
    app.kubernetes.io/name: kgateway
  ports:
  - name: xds
    port: 9977
    targetPort: 9977
  - name: admin
    port: 9093
    targetPort: 9093
  - name: grpc
    port: 9092
    targetPort: 9092
  - name: http
    port: 80
    targetPort: 8080
  type: ClusterIP
EOF
```

Persisted to git at `shopmesh-gitops/infrastructure/kgateway/kgateway-controller-svc.yaml` so ArgoCD will re-create it if it ever disappears.

**Result:** kgateway controller endpoints populated. Proxy connected to xDS. Proxy pod went `1/1 Running`.

---

### Fix 5: Frontend Pods Had Stale INTERNAL_ALB_URL

**Problem**

After the Gateway rename, `charts/frontend/values.yaml` was updated in git to point nginx at `http://prod.kgateway-system.svc.cluster.local:80`. But the running frontend pods had been started before this change and still had the old environment variable:

```
INTERNAL_ALB_URL=http://kgateway.kgateway-system.svc.cluster.local:80
```

The `kgateway` service on port 80 pointed to the controller (not the proxy), so nginx got no HTTP response → 504.

**Fix**

Forced ArgoCD to hard-refresh the frontend Application (to re-render the Helm chart from git and update the Deployment spec), then restarted the pods:

```bash
kubectl -n argocd annotate application frontend argocd.argoproj.io/refresh=hard --overwrite
kubectl rollout restart deployment/frontend -n production
```

**Result:** New pods started with `INTERNAL_ALB_URL=http://prod.kgateway-system.svc.cluster.local:80`. API calls began routing through the live proxy.

---

## How the System Works Now

### Components

| Component | What It Is | Location |
|---|---|---|
| External ALB | AWS Application Load Balancer | Public subnets (10.0.1.x, 10.0.2.x) |
| TargetGroupBinding | Registers frontend pod IPs directly into ALB target group | `production` namespace |
| frontend pod | nginx serving React SPA + proxy for `/api/*` | `production` namespace |
| kgateway controller | Watches Gateway/HTTPRoute K8s resources, programs Envoy via xDS | `kgateway-system` namespace |
| kgateway proxy (prod) | Envoy — receives HTTP traffic, routes to backend services | `kgateway-system` namespace |
| auth / product / order / analytics / ai-assistant | Backend microservices | `production` namespace |
| ExternalSecrets Operator | Pulls secrets from AWS Secrets Manager into K8s Secrets | `external-secrets` namespace |
| ArgoCD | GitOps controller — syncs `shopmesh-gitops` repo to cluster | `argocd` namespace |

---

## Request Flow

### Browser → ShopMesh Frontend (React App)

```
Browser
  │
  │  HTTP GET /
  ▼
AWS External ALB (shopmesh-external-alb-*.us-east-1.elb.amazonaws.com)
  │  Listener: port 80
  │  Rule: forward to target group shopmesh-frontend-tg
  │
  │  TargetGroupBinding (target_type=ip) →
  │  registered targets: frontend pod IPs (10.0.x.x:80)
  ▼
frontend pod — nginx
  │  location /   →  try_files → serve React index.html
  ▼
Browser renders React SPA
```

---

### Browser → API Call (e.g. POST /api/auth/login)

```
Browser
  │
  │  POST /api/auth/login
  ▼
AWS External ALB
  │  same listener / target group as above
  ▼
frontend pod — nginx
  │  location /api/auth {
  │      proxy_pass http://prod.kgateway-system.svc.cluster.local:80/api/auth;
  │  }
  ▼
kgateway prod Service (ClusterIP)
  │  Selector: app=prod (the proxy pod)
  │  Port 80 → pod port 80
  ▼
kgateway proxy pod (Envoy)
  │  Envoy received xDS routes from controller at startup:
  │    "if path prefix = /api/auth → forward to auth-service:3001"
  │  Matches HTTPRoute auth-route (namespace: production)
  ▼
auth-service pod (port 3001)
  │  Validates credentials against DynamoDB (via IRSA)
  │  Returns JWT token
  ▼
Response travels back up the same path → Browser
```

---

### How kgateway Controller Programs Envoy (xDS)

```
[git: shopmesh-gitops]
  infrastructure/kgateway/gateway.yaml   (Gateway: prod)
  infrastructure/kgateway/httproutes/    (6 HTTPRoute resources)
         │
         │  ArgoCD syncs → applies to cluster
         ▼
[kgateway-system namespace]
  kgateway controller pod
    │  Watches Gateway "prod" and all HTTPRoutes referencing it
    │  Builds Envoy xDS config (route table, clusters)
    │  Serves xDS on kgateway Service port 9977
         │
         │  gRPC stream (xDS)
         ▼
  kgateway proxy pod (Envoy)
    │  Bootstraps to kgateway.kgateway-system.svc.cluster.local:9977
    │  Receives route config:
    │    /api/auth      → auth-service.production.svc.cluster.local:3001
    │    /api/products  → product-service.production.svc.cluster.local:3002
    │    /api/orders    → order-service.production.svc.cluster.local:3003
    │    /api/analytics → analytics-service.production.svc.cluster.local:3004
    │    /api/assistant → ai-assistant-service.production.svc.cluster.local:3005
    │  Listens on port 80 (prod Service)
```

---

### GitOps Sync Flow (ArgoCD)

```
Developer pushes to shopmesh-gitops repo
         │
         ▼
ArgoCD (shopmesh-root app)
  watches applications/ directory recursively
         │
         ├── kgateway-app     → infrastructure/kgateway/   (prune: false)
         ├── httproutes-app   → infrastructure/kgateway/httproutes/
         ├── frontend-app     → charts/frontend/
         ├── auth-service-app → charts/auth-service/
         ├── product-app      → charts/product-service/
         ├── order-app        → charts/order-service/
         ├── analytics-app    → charts/analytics-service/
         └── ai-assistant-app → charts/ai-assistant-service/
         │
         ▼
Each app syncs its resources to the production namespace
ExternalSecrets pulls from AWS Secrets Manager (IRSA — no static credentials)
```

---

## Current Service Status

| Service | Port | Verified Response |
|---|---|---|
| auth-service | 3001 | `{"error":"Invalid email or password"}` on bad creds — service live |
| product-service | 3002 | `{"error":"Product not found"}` — service live |
| order-service | 3003 | `{"detail":"Authorization token required"}` — auth middleware working |
| analytics-service | 3004 | `{"detail":"Not Found"}` — service live |
| ai-assistant-service | 3005 | Route configured, not yet health-checked |
| frontend | 80 | React SPA serving, nginx proxying all `/api/*` correctly |

---

## Files Changed in This Session

| File | Change |
|---|---|
| `aws-terraform/terraform/modules/eks/outputs.tf` | Added `cluster_security_group_id` output |
| `aws-terraform/terraform/main.tf` | Added `aws_security_group_rule.alb_to_pods` |
| `shopmesh-gitops/infrastructure/kgateway/gateway.yaml` | Renamed Gateway from `kgateway` → `prod` |
| `shopmesh-gitops/infrastructure/kgateway/httproutes/*.yaml` | Updated all 6 HTTPRoutes: `parentRefs.name: kgateway` → `prod` |
| `shopmesh-gitops/infrastructure/kgateway/kgateway-controller-svc.yaml` | New file — persists the controller ClusterIP Service in git |
| `shopmesh-gitops/charts/frontend/values.yaml` | `INTERNAL_ALB_URL` updated to `http://prod.kgateway-system.svc.cluster.local:80` |
| `shopmesh-gitops/applications/infrastructure/kgateway-app.yaml` | Set `prune: false` to protect Helm-managed ServiceAccount/RBAC |
