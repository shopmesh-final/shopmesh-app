# ShopMesh EKS Deployment — Complete Execution Guide

**Account:** 242969680553 | **Region:** us-east-1 | **Cluster:** shopmesh-prod  
**GitOps repo:** https://github.com/shopmesh-final/shopmesh-gitops.git

---

## Phase 1 — Terraform

```bash
cd aws-terraform/terraform

# Initialise (downloads providers, connects to S3 backend)
terraform init

# Review plan — verify EKS, IRSA, ALB, ECR, DynamoDB, S3, SQS, SNS, Secrets Manager all appear
terraform plan -out=plan.tfplan

# Apply (~15-20 min, EKS cluster creation dominates)
terraform apply plan.tfplan
```

**Save these outputs — you need them in later phases:**

```bash
terraform output eks_cluster_name           # shopmesh-prod
terraform output frontend_target_group_arn  # needed for TargetGroupBinding
terraform output external_alb_dns_name      # set as CloudFront origin
terraform output route53_name_servers       # update domain registrar
```

---

## Phase 2 — Configure kubectl

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name shopmesh-prod

# Verify — should show 2 nodes Ready
kubectl get nodes
```

---

## Phase 3 — Scale Node Group to 3 Nodes

> **Required.** The CloudWatch Observability addon auto-injects ADOT init containers into
> every pod (4 init containers × 50-500m CPU/32-128Mi RAM each). Combined with 12
> backend pods + system workloads, 2 × t3.medium nodes are not enough. Scale to 3 first.

```bash
aws eks update-nodegroup-config \
  --cluster-name shopmesh-prod \
  --nodegroup-name shopmesh-prod-ng \
  --scaling-config minSize=2,maxSize=6,desiredSize=3 \
  --region us-east-1

# Wait until 3rd node is Ready (takes ~2 min)
kubectl get nodes -w
```

---

## Phase 4 — Install Helm (if not in PATH)

```bash
curl -fsSL -o helm.tar.gz https://get.helm.sh/helm-v3.16.2-linux-amd64.tar.gz
tar -xzf helm.tar.gz
sudo mv linux-amd64/helm /usr/local/bin/helm
helm version
```

---

## Phase 5 — Install Gateway API CRDs

> kgateway v2.3.1 requires Gateway API CRDs **v1.5.1**.
> The TLSRoute CRD will error (`isIP()` requires k8s 1.31+, cluster runs 1.30) — this is
> expected and non-blocking. All CRDs we use (Gateway, HTTPRoute, GatewayClass) apply fine.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml

# Confirm
kubectl get crd | grep gateway
# Must show: gatewayclasses, gateways, httproutes, grpcroutes, referencegrants
```

---

## Phase 6 — Install kgateway (Imperative — OCI, not managed by ArgoCD)

> kgateway has no public HTTP Helm repo — only OCI. Install imperatively like ArgoCD.
> ArgoCD manages only the Gateway and HTTPRoute resources (not the Helm chart itself).

```bash
# Step 1: kgateway namespace + CRDs
helm upgrade -i --create-namespace \
  --namespace kgateway-system \
  --version v2.3.1 kgateway-crds \
  oci://cr.kgateway.dev/kgateway-dev/charts/kgateway-crds

# Step 2: kgateway control plane
helm upgrade -i \
  --namespace kgateway-system \
  --version v2.3.1 kgateway \
  oci://cr.kgateway.dev/kgateway-dev/charts/kgateway

# Verify — pod goes Running after ADOT init containers complete (~1 min)
kubectl get pods -n kgateway-system -w
# Expected: kgateway-* 1/1 Running

kubectl get gatewayclass kgateway
# Expected: ACCEPTED=True
```

---

## Phase 7 — Install ArgoCD

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

kubectl create namespace argocd

helm install argocd argo/argo-cd \
  --namespace argocd \
  --version 7.8.26 \
  --wait

# Get initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
echo

# Port-forward to access UI (run in background or separate terminal)
kubectl port-forward svc/argocd-server -n argocd 8080:443 &
```

---

## Phase 8 — Build and Push Docker Images

> Run from your local machine (not CloudShell) where Docker is available.
> Terraform must have completed Phase 1 so ECR repos exist.

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  242969680553.dkr.ecr.us-east-1.amazonaws.com

ECR_BASE="242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh"

# Build and push each service (run from project root: aws-terraform/)
for svc in auth-service product-service order-service analytics-service ai-assistant-service frontend; do
  docker build -t ${ECR_BASE}/${svc}:latest ${svc}/
  docker push ${ECR_BASE}/${svc}:latest
  echo "✅ Pushed ${svc}"
done
```

---

## Phase 9 — Clone GitOps Repo and Apply Gateway Resources

```bash
# In CloudShell (where kubectl is configured)
git clone https://github.com/shopmesh-final/shopmesh-gitops.git
cd shopmesh-gitops

# Apply Gateway (creates the Envoy proxy + kgateway Service in kgateway-system)
kubectl apply -f infrastructure/kgateway/gateway.yaml

# Wait for kgateway to program the Gateway
kubectl get gateway kgateway -n kgateway-system -w
# Expected: PROGRAMMED=True

# Apply all 5 HTTPRoutes
kubectl apply -f infrastructure/kgateway/httproutes/

# Verify all routes attached
kubectl get httproutes -A
kubectl describe gateway kgateway -n kgateway-system | grep "Attached Routes"
# Expected: Attached Routes: 5

# Confirm the kgateway Envoy proxy Service exists
kubectl get svc -n kgateway-system
# Must include a Service named 'kgateway' on port 80
```

---

## Phase 10 — Bootstrap ArgoCD GitOps

```bash
cd ~/shopmesh-gitops

# Login to ArgoCD (use password from Phase 7)
argocd login localhost:8080 \
  --username admin \
  --password <password-from-phase-7> \
  --insecure

# Register the GitOps repo
argocd repo add https://github.com/shopmesh-final/shopmesh-gitops.git

# Apply the root App-of-Apps — this creates all child ArgoCD applications
kubectl apply -f bootstrap/root-application.yaml

# Trigger initial sync of root app (child apps are created automatically)
argocd app sync shopmesh-root

# Watch all apps appear and sync
argocd app list
# Wait until all 11 apps show: SYNC=Synced HEALTH=Healthy
```

---

## Phase 11 — Monitor and Wait for All Pods

```bash
# Watch all production pods come up
kubectl get pods -n production -w
# Expected: 12 pods total (2 replicas × 6 services), all 1/1 Running
# Allow 3-5 min for ExternalSecrets to sync JWT secret before auth/product start

# Check ExternalSecrets synced (jwt-secret must sync before auth+product pods can start)
kubectl get externalsecret -n production
# Expected: STATUS=SecretSynced READY=True for both

# Confirm all ArgoCD apps healthy
argocd app list
```

---

## Phase 12 — Validate End-to-End

```bash
# 1. kgateway is routing
FRONTEND_POD=$(kubectl get pod -n production -l app=frontend -o name | head -1)
kubectl exec $FRONTEND_POD -n production -c frontend -- \
  wget -qO- http://kgateway.kgateway-system.svc.cluster.local/health
# Expected: {"status":"OK","service":"kgateway"}

# 2. API routing through kgateway
kubectl exec $FRONTEND_POD -n production -c frontend -- \
  wget -qO- http://kgateway.kgateway-system.svc.cluster.local/api/auth/health
# Expected: {"status":"OK"} or similar

# 3. TargetGroupBinding registered frontend pod IPs
aws elbv2 describe-target-health \
  --target-group-arn $(kubectl get tgb frontend-tgb -n production \
    -o jsonpath='{.spec.targetGroupARN}') \
  --query 'TargetHealthDescriptions[*].{IP:Target.Id,Health:TargetHealth.State}'
# Expected: 2 entries with Health=healthy

# 4. ALB responds (replace with your ALB DNS)
curl -f http://$(terraform -chdir=aws-terraform/terraform output -raw external_alb_dns_name)/health
# Expected: {"status":"OK","service":"frontend"}

# 5. Full HTTPS via CloudFront
curl -f https://shopmesh.shop/health
```

---

## Troubleshooting

### Pod stuck in Pending — "Too many pods"
```bash
# Add a 4th node temporarily
aws eks update-nodegroup-config \
  --cluster-name shopmesh-prod \
  --nodegroup-name shopmesh-prod-ng \
  --scaling-config minSize=2,maxSize=6,desiredSize=4 \
  --region us-east-1
```

### Frontend CrashLoopBackOff — "host not found in upstream kgateway"
kgateway isn't ready yet. Check:
```bash
kubectl get pods -n kgateway-system         # must be 1/1 Running
kubectl get gateway kgateway -n kgateway-system  # PROGRAMMED must be True
kubectl get svc -n kgateway-system          # 'kgateway' Service must exist
```

### Frontend CrashLoopBackOff — CORECLR_ENABLE_PROFILING / LD_PRELOAD
ADOT auto-instrumentation was injected. The frontend Helm chart has opt-out annotations
(`instrumentation.opentelemetry.io/inject-dotnet: "false"` etc.) — verify they're present:
```bash
kubectl describe pod -n production -l app=frontend | grep inject
# Must show: inject-dotnet: false, inject-java: false, etc.
```
If not, ArgoCD hasn't synced the latest frontend chart yet — force sync:
```bash
argocd app sync frontend
```

### ExternalSecrets not syncing — auth/product service pods failing
```bash
kubectl describe clustersecretstore aws-secrets-manager
kubectl get externalsecret -n production -o wide
# If SecretSynced=False, check IRSA on external-secrets ServiceAccount:
kubectl get sa -n external-secrets external-secrets-sa -o yaml | grep role-arn
```

### aws-load-balancer-controller Degraded in ArgoCD
Check the LBC pod:
```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=30
```

### ArgoCD app OutOfSync after kgateway pod shows ADOT annotations
kgateway pod gets ADOT annotations injected at runtime — ArgoCD sees drift between
desired (no annotations) and actual (with annotations). This is cosmetic. Force sync:
```bash
argocd app sync kgateway --force
```

### Check IRSA is working for any service
```bash
# Example: auth-service
kubectl exec -n production deploy/auth-service -- \
  env | grep -E "AWS_ROLE_ARN|AWS_WEB_IDENTITY_TOKEN_FILE"
# Must show both variables
```

---

## Architecture Reference

```
Browser
  └─► Route53 (shopmesh.shop)
        └─► CloudFront
              └─► External ALB (public)
                    └─► frontend pod (nginx, production ns)
                          │  INTERNAL_ALB_URL=http://kgateway.kgateway-system.svc:80
                          └─► kgateway (Envoy proxy, kgateway-system ns)
                                ├─ /api/auth     ─► auth-service:3001
                                ├─ /api/products ─► product-service:3002
                                ├─ /api/orders   ─► order-service:3003
                                ├─ /api/analytics─► analytics-service:3004
                                └─ /api/assistant─► ai-assistant-service:3005
                                                      │
                                              DynamoDB / S3 / SQS / SNS
                                              Secrets Manager / Bedrock
                                              (all via IRSA — no static creds)
```

## Key Versions

| Component | Version |
|-----------|---------|
| Kubernetes (EKS) | 1.30 |
| kgateway | v2.3.1 |
| Gateway API CRDs | v1.5.1 |
| ArgoCD Helm chart | 7.8.26 |
| Helm | 3.16.2 |
| AWS LBC (ArgoCD managed) | 3.4.0 |
