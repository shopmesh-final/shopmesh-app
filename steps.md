# ShopMesh EKS Deployment Runbook

**Account:** `242969680553` | **Region:** `us-east-1` | **Cluster:** `shopmesh-prod`

---

## Prerequisites

```bash
# Verify all required tools
aws --version          # >= 2.x
terraform --version    # >= 1.6.0
kubectl version --client  # >= 1.28
helm version           # >= 3.12
docker --version       # >= 24.x
git --version

# Confirm AWS identity
aws sts get-caller-identity
# Expected: Account 242969680553, Region us-east-1

# Set default region for all AWS CLI calls
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCOUNT_ID=242969680553
export CLUSTER_NAME=shopmesh-prod
export PROJECT_NAME=shopmesh
```

---

## Phase 1 — Terraform: Provision Infrastructure

```bash
cd aws-terraform/terraform

# Initialize — downloads providers (aws, tls) and configures S3 remote backend
terraform init

# Expected backend output:
#   Initializing the backend...
#   Successfully configured the backend "s3"!
#   State path: shopmesh/terraform.tfstate

# Review what will be created (EKS cluster takes ~15 min)
terraform plan -out=eks.tfplan 2>&1 | tee /tmp/plan.out

# Verify the plan adds only:
grep "# module.eks\|# module.irsa\|# aws_eks_addon.cloudwatch" /tmp/plan.out

# Apply — expected runtime: 15–20 minutes
terraform apply eks.tfplan

# Capture all outputs for use in later phases
terraform output -json > /tmp/tf-outputs.json

# Extract specific values used throughout this runbook
export TF_EKS_CLUSTER=$(terraform output -raw eks_cluster_name)
export TF_OIDC_URL=$(terraform output -raw eks_oidc_issuer_url)
export TF_FRONTEND_TG_ARN=$(terraform output -raw frontend_target_group_arn)
export TF_LBC_ROLE=$(terraform output -raw irsa_aws_lb_controller_role_arn)
export TF_ESO_ROLE=$(terraform output -raw irsa_external_secrets_role_arn)

echo "Cluster: $TF_EKS_CLUSTER"
echo "Frontend TG ARN: $TF_FRONTEND_TG_ARN"
```

---

## Phase 2 — Configure kubectl + EKS Verification

```bash
# Merge EKS credentials into kubeconfig
aws eks update-kubeconfig \
  --region us-east-1 \
  --name shopmesh-prod

# Verify cluster access
kubectl cluster-info
# Expected: Kubernetes control plane at https://<OIDC-endpoint>.gr7.us-east-1.eks.amazonaws.com

# Verify 2 nodes are Ready (takes 3–5 min after Terraform completes)
kubectl get nodes -o wide
# Expected:
#   NAME                           STATUS   ROLES    AGE   VERSION   INTERNAL-IP
#   ip-10-0-10-xxx.ec2.internal    Ready    <none>   5m    v1.30.x   10.0.10.x
#   ip-10-0-11-xxx.ec2.internal    Ready    <none>   5m    v1.30.x   10.0.11.x

# Confirm nodes are in private subnets (10.0.10.x and 10.0.11.x only)
kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'

# Verify system add-ons are running
kubectl get pods -n kube-system
# Expected Running: coredns (x2), kube-proxy (x2), aws-node (vpc-cni, x2)

# Verify OIDC issuer URL is attached
aws eks describe-cluster --name shopmesh-prod \
  --query 'cluster.identity.oidc.issuer' --output text
# Expected: https://oidc.eks.us-east-1.amazonaws.com/id/<ID>

# Confirm OIDC provider exists in IAM
aws iam list-open-id-connect-providers \
  --query 'OpenIDConnectProviderList[].Arn' --output table

# Confirm all 10 IRSA roles were created
aws iam list-roles \
  --query "Roles[?contains(RoleName,'shopmesh-irsa')].RoleName" \
  --output table
# Expected: 10 roles (auth-service, product-service, order-service,
#            analytics-service, ai-assistant-service, external-secrets,
#            aws-lb-controller, cloudwatch-agent, fluent-bit, ebs-csi)
```

---

## Phase 3 — Create Namespaces

```bash
# Create all required namespaces
kubectl create namespace production
kubectl create namespace kgateway-system
kubectl create namespace external-secrets
kubectl create namespace argocd
kubectl create namespace amazon-cloudwatch

# Label kgateway-system so NetworkPolicy selectors work
# (GitOps also enforces this via infrastructure/kgateway/namespace.yaml)
kubectl label namespace kgateway-system name=kgateway-system

# Verify
kubectl get namespaces | grep -E "production|kgateway|external|argocd|cloudwatch"
kubectl get namespace kgateway-system --show-labels
# Expected label: name=kgateway-system
```

---

## Phase 4 — Build and Push Docker Images to ECR

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login \
    --username AWS \
    --password-stdin \
    ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com

# Build and push all 6 services
for SVC in auth-service product-service order-service analytics-service ai-assistant-service frontend; do
  echo "==> Building ${SVC}..."
  docker build \
    -t ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/${PROJECT_NAME}/${SVC}:latest \
    aws-terraform/${SVC}/

  echo "==> Pushing ${SVC}..."
  docker push \
    ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/${PROJECT_NAME}/${SVC}:latest

  echo "==> Done: ${SVC}"
done

# Verify all images are in ECR
aws ecr describe-repositories \
  --query 'repositories[].repositoryName' --output table

for SVC in auth-service product-service order-service analytics-service ai-assistant-service frontend; do
  DIGEST=$(aws ecr describe-images \
    --repository-name ${PROJECT_NAME}/${SVC} \
    --query 'imageDetails[0].imageTags[0]' \
    --output text 2>/dev/null)
  echo "${SVC}: ${DIGEST}"
done
```

---

## Phase 5 — Helm Infrastructure: AWS LBC, External Secrets, kgateway, Metrics Server

```bash
# Add all Helm repositories
helm repo add eks              https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo add kgateway         https://kgateway-dev.github.io/helm-charts
helm repo add metrics-server   https://kubernetes-sigs.github.io/metrics-server/
helm repo update

# ── 5a. AWS Load Balancer Controller ──────────────────────────────────────
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --version 1.8.1 \
  --set clusterName=shopmesh-prod \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${TF_LBC_ROLE}" \
  --set region=us-east-1 \
  --wait --timeout=5m

# Verify
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
# Expected: 2 pods Running

# ── 5b. External Secrets Operator ─────────────────────────────────────────
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --version 0.9.20 \
  --set installCRDs=true \
  --set serviceAccount.name=external-secrets-sa \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${TF_ESO_ROLE}" \
  --wait --timeout=5m

# Verify CRDs installed
kubectl get crd | grep external-secrets
# Expected: clustersecretstores.external-secrets.io, externalsecrets.external-secrets.io

kubectl get pods -n external-secrets
# Expected: external-secrets, external-secrets-cert-controller, external-secrets-webhook Running

# ── 5c. kgateway ──────────────────────────────────────────────────────────
helm install kgateway kgateway/kgateway \
  --namespace kgateway-system \
  --version 1.0.3 \
  --set fullnameOverride=kgateway \
  --set service.type=ClusterIP \
  --wait --timeout=5m

# Verify
kubectl get pods -n kgateway-system
# Expected: kgateway pods Running

kubectl get gatewayclass
# Expected: kgateway  gateway.kgateway.dev/gatewayclass-controller  Accepted

# ── 5d. Metrics Server ────────────────────────────────────────────────────
helm install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --version 3.12.1 \
  --set args[0]=--kubelet-preferred-address-types=InternalIP \
  --set args[1]=--kubelet-insecure-tls \
  --wait --timeout=3m

# Verify (takes ~60s to collect first metrics)
kubectl top nodes
# Expected: CPU and memory values (not <unknown>)
```

---

## Phase 6 — Apply Kubernetes Manifests

```bash
# ── 6a. kgateway Gateway + HTTPRoutes ─────────────────────────────────────
kubectl apply -f shopmesh-gitops/infrastructure/kgateway/namespace.yaml
kubectl apply -f shopmesh-gitops/infrastructure/kgateway/gatewayclass.yaml
kubectl apply -f shopmesh-gitops/infrastructure/kgateway/gateway.yaml
kubectl apply -f shopmesh-gitops/infrastructure/kgateway/httproutes/

# Verify Gateway is Programmed
kubectl get gateway shopmesh-gateway -n kgateway-system
# Expected: PROGRAMMED=True

kubectl get httproutes -n production
# Expected: 5 routes (auth, products, orders, analytics, assistant)

# ── 6b. ClusterSecretStore ────────────────────────────────────────────────
kubectl apply -f shopmesh-gitops/infrastructure/external-secrets/cluster-secret-store.yaml

# Verify ESO can reach Secrets Manager (takes ~30s)
kubectl get clustersecretstore aws-secrets-manager
# Expected: READY=True

# If READY stays False, check IRSA is working for ESO:
kubectl describe clustersecretstore aws-secrets-manager
```

---

## Phase 7 — Deploy ShopMesh Helm Charts

```bash
# Deploy in dependency order: auth first, frontend last

# ── auth-service ──────────────────────────────────────────────────────────
helm install auth-service helm/charts/auth-service \
  --namespace production \
  --wait --timeout=3m

# Verify ExternalSecret synced before proceeding
kubectl get externalsecret auth-service-secret -n production
# Expected: READY=True, STATUS=SecretSynced

# ── product-service ───────────────────────────────────────────────────────
helm install product-service helm/charts/product-service \
  --namespace production \
  --wait --timeout=3m

kubectl get externalsecret product-service-secret -n production
# Expected: READY=True, STATUS=SecretSynced

# ── order-service ─────────────────────────────────────────────────────────
helm install order-service helm/charts/order-service \
  --namespace production \
  --wait --timeout=3m

# ── analytics-service ─────────────────────────────────────────────────────
helm install analytics-service helm/charts/analytics-service \
  --namespace production \
  --wait --timeout=3m

# ── ai-assistant-service ──────────────────────────────────────────────────
helm install ai-assistant-service helm/charts/ai-assistant-service \
  --namespace production \
  --wait --timeout=5m

# ── frontend (requires TG ARN from Terraform output) ──────────────────────
helm install frontend helm/charts/frontend \
  --namespace production \
  --set targetGroupArn="${TF_FRONTEND_TG_ARN}" \
  --wait --timeout=3m

# Verify all 12 pods are Running (2 per service)
kubectl get pods -n production
# Expected: 12 pods total, all 1/1 Running

kubectl get hpa -n production
# Expected: all 6 HPAs with MINPODS=2, CURRENT metrics populated

kubectl get targetgroupbinding -n production
# Expected: frontend-tgb  READY=True

# Confirm frontend pod IPs registered in ALB target group
aws elbv2 describe-target-health \
  --target-group-arn "${TF_FRONTEND_TG_ARN}" \
  --query 'TargetHealthDescriptions[].{IP:Target.Id,Port:Target.Port,State:TargetHealth.State}' \
  --output table
# Expected: 2 entries, State=healthy
```

---

## Phase 8 — Install ArgoCD

```bash
# Add ArgoCD Helm repo
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# Install ArgoCD (NOT managed by ArgoCD itself)
helm install argocd argo/argo-cd \
  --namespace argocd \
  --version 7.6.12 \
  --set configs.params."server\.insecure"=true \
  --wait --timeout=10m

# Verify all ArgoCD pods are Running
kubectl get pods -n argocd
# Expected: argocd-server, argocd-repo-server, argocd-application-controller,
#           argocd-applicationset-controller, argocd-dex-server, argocd-redis Running

# Retrieve initial admin password
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d)
echo "ArgoCD admin password: ${ARGOCD_PASSWORD}"

# Port-forward ArgoCD UI (keep terminal open, use a separate terminal for next steps)
kubectl port-forward svc/argocd-server -n argocd 8080:80 &

# Login via CLI
argocd login localhost:8080 \
  --username admin \
  --password "${ARGOCD_PASSWORD}" \
  --insecure

# Change admin password (recommended)
argocd account update-password \
  --current-password "${ARGOCD_PASSWORD}" \
  --new-password "<your-new-password>"
```

---

## Phase 9 — Bootstrap GitOps (App of Apps)

```bash
# Replace YOUR_ORG with your actual GitHub organization in all ArgoCD app files
export GITHUB_ORG="<your-github-org>"

find shopmesh-gitops/ -name "*.yaml" -exec \
  sed -i "s/YOUR_ORG/${GITHUB_ORG}/g" {} \;

# Verify substitution
grep -r "YOUR_ORG" shopmesh-gitops/
# Expected: no output (all replaced)

# Commit and push the GitOps repo
git -C shopmesh-gitops init
git -C shopmesh-gitops add .
git -C shopmesh-gitops commit -m "Initial ShopMesh GitOps configuration"
git -C shopmesh-gitops remote add origin \
  https://github.com/${GITHUB_ORG}/shopmesh-gitops.git
git -C shopmesh-gitops push -u origin main

# Register the GitOps repo with ArgoCD
argocd repo add https://github.com/${GITHUB_ORG}/shopmesh-gitops \
  --username git \
  --password "<github-pat-or-deploy-key>"

# Also register the main shopmesh repo (where helm/charts/ lives)
argocd repo add https://github.com/${GITHUB_ORG}/shopmesh \
  --username git \
  --password "<github-pat-or-deploy-key>"

# Apply the root application (App of Apps)
kubectl apply -f shopmesh-gitops/bootstrap/root-application.yaml

# Trigger initial sync of root app
argocd app sync shopmesh-root

# Watch all child apps appear and sync
argocd app list
# Expected: shopmesh-root + 10 child apps appear within ~60s

# Wait for all apps to reach Synced + Healthy
argocd app wait shopmesh-root \
  --sync \
  --health \
  --timeout 300

# Individual app status
argocd app list
# Expected: all 11 apps STATUS=Synced, HEALTH=Healthy
```

---

## Phase 10 — Full Validation

```bash
# ── Cluster ───────────────────────────────────────────────────────────────
kubectl get nodes -o wide
# Expected: 2 nodes Ready, private IPs 10.0.10.x + 10.0.11.x

# ── System Pods ───────────────────────────────────────────────────────────
kubectl get pods -n kube-system
# Expected Running: coredns(x2), kube-proxy(x2), aws-node(x2),
#                   aws-load-balancer-controller(x2), metrics-server(x1)

# ── Production Pods ───────────────────────────────────────────────────────
kubectl get pods -n production -o wide
# Expected: 12 pods, all 1/1 Running, spread across both nodes

# ── IRSA Token Injection ──────────────────────────────────────────────────
kubectl exec -n production deploy/auth-service -- \
  ls /var/run/secrets/eks.amazonaws.com/serviceaccount/
# Expected: token (file exists)

kubectl exec -n production deploy/auth-service -- \
  env | grep -E "AWS_ROLE_ARN|AWS_WEB_IDENTITY_TOKEN_FILE"
# Expected:
#   AWS_ROLE_ARN=arn:aws:iam::242969680553:role/shopmesh-irsa-auth-service
#   AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token

# ── ExternalSecrets Sync ──────────────────────────────────────────────────
kubectl get externalsecrets -n production
# Expected: auth-service-secret and product-service-secret STATUS=SecretSynced

kubectl get secret auth-service-secret -n production \
  -o jsonpath='{.data.JWT_SECRET}' | base64 -d | wc -c
# Expected: >0 characters (secret has content)

# ── Service Health Checks ─────────────────────────────────────────────────
for SVC in auth-service:3001 product-service:3002 order-service:3003 analytics-service:3004 ai-assistant-service:3005; do
  NAME=$(echo $SVC | cut -d: -f1)
  PORT=$(echo $SVC | cut -d: -f2)
  echo -n "==> ${NAME}: "
  kubectl exec -n production deploy/${NAME} -- \
    wget -qO- --timeout=5 http://localhost:${PORT}/health 2>/dev/null || echo "FAIL"
done
# Expected: each service returns {"status":"ok"} or similar

# ── kgateway Routing ──────────────────────────────────────────────────────
kubectl exec -n production deploy/auth-service -- \
  wget -qO- --timeout=5 \
  http://kgateway.kgateway-system.svc.cluster.local/api/auth/health
# Expected: auth-service health response

kubectl exec -n production deploy/order-service -- \
  wget -qO- --timeout=5 \
  http://kgateway.kgateway-system.svc.cluster.local/api/products/ 2>&1
# Expected: products list (confirms cross-service routing via kgateway)

# ── TargetGroupBinding ────────────────────────────────────────────────────
kubectl get targetgroupbinding -n production frontend-tgb -o wide
# Expected: READY=True

aws elbv2 describe-target-health \
  --target-group-arn "${TF_FRONTEND_TG_ARN}" \
  --query 'TargetHealthDescriptions[].{IP:Target.Id,State:TargetHealth.State}' \
  --output table
# Expected: 2 rows, both State=healthy

# ── External ALB (HTTP) ───────────────────────────────────────────────────
EXTERNAL_ALB=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName,'${PROJECT_NAME}')].DNSName" \
  --output text | head -1)

curl -f -s -o /dev/null -w "%{http_code}" http://${EXTERNAL_ALB}/health
# Expected: 200

# ── End-to-end API through CloudFront ─────────────────────────────────────
DOMAIN=$(cd aws-terraform/terraform && terraform output -raw app_url)
curl -f -s -o /dev/null -w "%{http_code}" ${DOMAIN}/api/products/
# Expected: 200

# ── Autoscaling ───────────────────────────────────────────────────────────
kubectl get hpa -n production
# Expected: MINPODS=2, MAXPODS=6, TARGETS shows real % (not <unknown>)

kubectl top pods -n production
# Expected: CPU and memory values for all 12 pods

# ── ArgoCD ────────────────────────────────────────────────────────────────
argocd app list
# Expected: all apps SYNC STATUS=Synced, HEALTH STATUS=Healthy

# ── GitOps Drift Test ─────────────────────────────────────────────────────
# Push a change (e.g., replica count bump) and confirm ArgoCD auto-syncs
# Edit helm/charts/auth-service/values.yaml: replicaCount: 3
# git commit + push → ArgoCD detects and syncs within 3 minutes
kubectl get pods -n production -l app=auth-service --watch
# Expected: 3rd pod appears within ~3 minutes
```

---

## Phase 11 — Troubleshooting

### Pods not starting (ImagePullBackOff)

```bash
kubectl describe pod -n production <pod-name> | grep -A5 Events
# If "401 Unauthorized": node role is missing AmazonEC2ContainerRegistryReadOnly

aws iam list-attached-role-policies \
  --role-name shopmesh-eks-node-role \
  --query 'AttachedPolicies[].PolicyName' --output table
```

### IRSA not working (AccessDenied from AWS SDK)

```bash
# Check token file is mounted
kubectl exec -n production deploy/<service> -- \
  ls -la /var/run/secrets/eks.amazonaws.com/serviceaccount/

# Verify the role ARN annotation on the ServiceAccount
kubectl get serviceaccount <service> -n production -o yaml \
  | grep eks.amazonaws.com/role-arn

# Decode and inspect the OIDC token (check sub claim)
kubectl exec -n production deploy/<service> -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token \
  | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Compare sub claim against IRSA trust policy condition
aws iam get-role --role-name shopmesh-irsa-<service> \
  --query 'Role.AssumeRolePolicyDocument' --output json
```

### ExternalSecret stuck (SecretSyncedError)

```bash
kubectl describe externalsecret auth-service-secret -n production
# Look for: "could not get secret value" → IRSA issue on ESO pod

kubectl logs -n external-secrets \
  -l app.kubernetes.io/name=external-secrets --tail=50

# Verify ESO ServiceAccount has correct annotation
kubectl get sa external-secrets-sa -n external-secrets -o yaml \
  | grep role-arn

# Manually test Secrets Manager access from ESO pod
kubectl exec -n external-secrets deploy/external-secrets -- \
  aws secretsmanager get-secret-value \
  --secret-id shopmesh/jwt-secret \
  --region us-east-1
```

### kgateway not routing (502 / no upstream)

```bash
# Check Gateway is programmed
kubectl get gateway shopmesh-gateway -n kgateway-system -o yaml \
  | grep -A5 conditions

# Check HTTPRoute has valid backend
kubectl describe httproute auth-route -n production

# Check kgateway pods are healthy
kubectl logs -n kgateway-system -l app.kubernetes.io/name=kgateway --tail=50

# Verify Service endpoints exist (pods must be Ready)
kubectl get endpoints auth-service -n production
# Expected: IPs listed — if <none>, pods are not Ready
```

### TargetGroupBinding: pods not healthy in ALB

```bash
kubectl describe targetgroupbinding frontend-tgb -n production
# Look for: "error registering targets" → LBC IRSA issue

kubectl logs -n kube-system \
  -l app.kubernetes.io/name=aws-load-balancer-controller --tail=100 \
  | grep -E "ERROR|error|frontend"

# Verify LBC SA annotation
kubectl get sa aws-load-balancer-controller -n kube-system -o yaml \
  | grep role-arn

# Check ALB security group allows traffic to node ports
aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=shopmesh-*" \
  --query 'SecurityGroups[].{Name:GroupName,Rules:IpPermissions}' \
  --output json
```

### HPA showing `<unknown>` metrics

```bash
# Metrics server must be running
kubectl get pods -n kube-system -l app.kubernetes.io/name=metrics-server
kubectl logs -n kube-system -l app.kubernetes.io/name=metrics-server --tail=20

# Test metrics API directly
kubectl get --raw /apis/metrics.k8s.io/v1beta1/pods | python3 -m json.tool | head -30

# HPA requires at least 1 successful metrics scrape (wait 90s after deploy)
kubectl describe hpa auth-service -n production | grep -A5 Conditions
```

### ArgoCD app stuck OutOfSync

```bash
argocd app diff <app-name>
# Shows exactly what differs between Git and cluster

# Force refresh (re-read Git without waiting for poll interval)
argocd app get <app-name> --refresh

# Manual sync with dry-run to preview
argocd app sync <app-name> --dry-run

# Actual sync
argocd app sync <app-name>

# If stuck on finalizers during deletion:
kubectl patch application <app-name> -n argocd \
  -p '{"metadata":{"finalizers":null}}' --type=merge
```

### CloudWatch Container Insights not reporting

```bash
# Verify cloudwatch-observability addon status
aws eks describe-addon \
  --cluster-name shopmesh-prod \
  --addon-name amazon-cloudwatch-observability \
  --query 'addon.status'
# Expected: ACTIVE

# Check cloudwatch-agent pods
kubectl get pods -n amazon-cloudwatch
kubectl logs -n amazon-cloudwatch \
  -l app.kubernetes.io/name=cloudwatch-agent --tail=30

# Verify IRSA role annotation on cloudwatch-agent SA
kubectl get sa cloudwatch-agent -n amazon-cloudwatch -o yaml \
  | grep role-arn
```

---

## Rollback

```bash
# Traffic-only rollback (seconds — EC2 ASG takes over immediately)
kubectl delete targetgroupbinding frontend-tgb -n production

# Verify EC2 instances reregistered in target group
aws elbv2 describe-target-health \
  --target-group-arn "${TF_FRONTEND_TG_ARN}" \
  --output table

# Scale EKS to zero (stop cost without destroying infra)
kubectl scale deployment --all --replicas=0 -n production

# Full EKS teardown (last resort — leaves all other AWS resources intact)
cd aws-terraform/terraform
terraform destroy \
  -target=aws_eks_addon.cloudwatch_observability \
  -target=module.irsa \
  -target=module.eks \
  -auto-approve
```

---

---

# CI Pipeline Go-Live — GitHub Repo Setup + Secrets Checklist

The CI pipeline (6 workflow files in `.github/workflows/`) is fully built locally.
Two repos are involved:
- **App repo** (new) — `shopmesh-final/shopmesh` — contains `aws-terraform/<services>/` + `.github/workflows/`
- **GitOps repo** (existing) — `shopmesh-final/shopmesh-gitops` — `update-helm.yml` pushes image tags here

---

## CI Phase 1 — Create GitHub Repository and Push

### 1.1 Create the repo on GitHub

```bash
gh repo create shopmesh-final/shopmesh --private --description "ShopMesh microservices monorepo"
```

Or go to **github.com → New repository** (private, no auto-init).

### 1.2 Initialize git and push

Run from `internal-final/` (Git Bash):

```bash
cd /c/Users/307496/Desktop/internal-final

git init
git branch -M main

git add .github/
git add aws-terraform/auth-service/
git add aws-terraform/product-service/
git add aws-terraform/order-service/
git add aws-terraform/analytics-service/
git add aws-terraform/ai-assistant-service/
git add aws-terraform/frontend/
git add aws-terraform/terraform/
git add .gitignore

git commit -m "feat: initial commit — ShopMesh microservices + CI pipeline"

git remote add origin https://github.com/shopmesh-final/shopmesh.git
git push -u origin main
```

**Do NOT push:**
- `shopmesh-gitops/` — separate GitHub repo
- `shared-workflows-template/` — old template, no longer needed
- Any `.terraform/` directories or `*.tfstate` files (covered by `.gitignore`)

---

## CI Phase 2 — AWS: Create GitHub OIDC IAM Role

One-time setup in account `242969680553`. Lets GitHub Actions runners assume an IAM role
via OIDC token exchange to push Docker images to ECR — no stored AWS credentials in GitHub.

### 2.1 Check if OIDC provider already exists

```bash
aws iam list-open-id-connect-providers | grep token.actions
# If output is empty, create it in the next step. If it shows an ARN, skip to 2.2.
```

### 2.1a Create OIDC provider (only if not present)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --region us-east-1
```

### 2.2 Create trust policy file

Save as `github-ci-trust.json` on your local machine:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::242969680553:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:shopmesh-final/*:*"
      }
    }
  }]
}
```

### 2.3 Create ECR permissions policy file

Save as `github-ci-ecr-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:us-east-1:242969680553:repository/shopmesh/*"
    }
  ]
}
```

### 2.4 Create role and attach policy

```bash
aws iam create-role \
  --role-name shopmesh-github-ci \
  --assume-role-policy-document file://github-ci-trust.json

aws iam put-role-policy \
  --role-name shopmesh-github-ci \
  --policy-name ECRPush \
  --policy-document file://github-ci-ecr-policy.json

# Confirm ARN (needed for GitHub variable in CI Phase 3)
aws iam get-role --role-name shopmesh-github-ci --query 'Role.Arn' --output text
# Expected: arn:aws:iam::242969680553:role/shopmesh-github-ci
```

---

## CI Phase 3 — GitHub: Configure Secrets and Variables

Go to: **github.com → shopmesh-final/shopmesh → Settings → Secrets and variables → Actions**

### 3.1 Repository Secrets

| Secret | Value | Where to get it |
|---|---|---|
| `SONAR_TOKEN` | SonarQube user token | SonarQube → My Account → Security |
| `SONAR_HOST_URL` | `https://your-sonarqube-host.com` | Your SonarQube server URL |
| `SNYK_TOKEN` | Snyk API token | app.snyk.io → Settings → Service Accounts |
| `GITOPS_TOKEN` | GitHub fine-grained PAT | See 3.2 below |
| `SENDGRID_API_KEY` | SendGrid API key | sendgrid.com → Settings → API Keys |
| `NOTIFY_FROM_EMAIL` | e.g. `ci@shopmesh.shop` | Must be a verified sender in SendGrid |
| `NOTIFY_TO_EMAIL` | `srideviguttula50@gmail.com` | Alert recipient |

### 3.2 Create `GITOPS_TOKEN`

`update-helm.yml` pushes commits to `shopmesh-final/shopmesh-gitops`. It needs a
fine-grained PAT with write access scoped only to that repo.

1. Go to: **github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set:
   - Token name: `shopmesh-ci-gitops`
   - Expiration: 1 year
   - Resource owner: `shopmesh-final`
   - Repository access: **Only select repositories** → `shopmesh-final/shopmesh-gitops`
   - Permissions → **Contents**: `Read and write`
4. Copy the token and add it as the `GITOPS_TOKEN` secret

### 3.3 Repository Variable

Go to **Settings → Secrets and variables → Actions → Variables tab**

| Variable | Value |
|---|---|
| `AWS_CI_ROLE_ARN` | `arn:aws:iam::242969680553:role/shopmesh-github-ci` |

---

## CI Phase 4 — Verify: First Pipeline Run

### 4.1 Test on a PR (safest first test — no ECR push)

```bash
git checkout -b test/ci-pipeline-validation
echo "# CI test" >> aws-terraform/product-service/README.md
git add aws-terraform/product-service/README.md
git commit -m "test: trigger product-service CI"
git push origin test/ci-pipeline-validation
```

Open a PR against `main` on GitHub. Expected in the Actions tab:

```
✓ detect-changes     → product-service: true, all others: false
✓ build-test         → product-service only (1 job)
✓ code-quality       → product-service only (SonarQube + Snyk)
✓ image-pipeline     → product-service only (Docker build + Trivy, no ECR push)
✗ update-helm        → SKIPPED (PR, not main push)
✗ notify-failure     → SKIPPED (no failures)
```

In the `detect-changes` job logs, confirm:

```
Changed service count: 1
Matrix: {"include":[{"service":"product-service","path":"aws-terraform/product-service","runtime":"node"}]}
```

### 4.2 Merge to main — full pipeline

Merge the PR. Expected:

```
✓ detect-changes
✓ build-test         → product-service
✓ code-quality       → product-service
✓ image-pipeline     → product-service (Trivy + ECR push)
✓ update-helm        → product-service (writes sha7 to shopmesh-gitops)
```

### 4.3 Verify ECR image

```bash
aws ecr describe-images \
  --repository-name shopmesh/product-service \
  --region us-east-1 \
  --query 'imageDetails[*].{Tag:imageTags[0],Pushed:imagePushedAt}' \
  --output table
# Expected: a row with the 7-char git SHA as the tag
```

### 4.4 Verify Helm values updated

```bash
# In the shopmesh-gitops repo
git -C shopmesh-gitops log --oneline -3 charts/product-service/values.yaml
# Expected: ci: update product-service image to <sha7>

grep "tag:" shopmesh-gitops/charts/product-service/values.yaml
# Expected: tag: <sha7>
```

### 4.5 Confirm ArgoCD rolled the pod

```bash
kubectl rollout status deployment/product-service -n production
# Expected: deployment "product-service" successfully rolled out

kubectl describe pod -n production -l app=product-service \
  | grep "Image:"
# Expected: 242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/product-service:<sha7>
```

---

## CI Pipeline — End-to-End Flow Summary

```
Developer edits aws-terraform/product-service/**
            ↓
detect-changes  →  product-service: true (others: false)
            ↓
build-test  →  npm install + npm test (Node, product-service only)
            ↓
code-quality  →  SonarQube quality gate + Snyk HIGH/CRITICAL check
            ↓
image-pipeline  →  Docker build + Trivy (vuln+secret+misconfig, HIGH/CRITICAL)
            ↓  (main branch only from here)
ECR push  →  242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/product-service:<sha7>
            ↓
update-helm  →  git commit to shopmesh-gitops: charts/product-service/values.yaml image.tag = <sha7>
            ↓
ArgoCD detects diff in shopmesh-gitops (polls every 3 min)
            ↓
Rolling update in EKS production namespace — old pod terminated, new pod starts
            ↓
kubectl rollout status → "successfully rolled out"
```

No manual `kubectl apply` or `helm upgrade` ever needed after this point.
