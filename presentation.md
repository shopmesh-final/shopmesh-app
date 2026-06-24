# ShopMesh — Presentation Slides
### 15-Slide Deck | Cloud-Native E-Commerce on AWS EKS

---

## Slide 1 — ShopMesh: Cloud-Native E-Commerce on AWS

**Key Points (on screen):**
- A fully cloud-native e-commerce platform on Amazon EKS
- 6 independent microservices — Auth, Products, Orders, Analytics, AI Assistant, Frontend
- Live at **https://shopmesh.shop**
- AWS Account: `242969680553` | Region: `us-east-1` | Cluster: `shopmesh-prod`
- Capstone: Complete migration from EC2 Auto Scaling Groups → Kubernetes

**Speaker Notes:**
Good morning / afternoon everyone. Today I'm presenting ShopMesh — a cloud-native e-commerce platform I built as a capstone project. ShopMesh is a fully working online store where users can browse products, place orders, view analytics, and even chat with an AI shopping assistant powered by Amazon Bedrock. Everything you see is live — the domain shopmesh.shop is running right now on 4 EKS worker nodes in us-east-1. The goal of this project was to demonstrate a real-world migration from old-style EC2 Virtual Machines to a modern containerized Kubernetes setup on AWS EKS, with full GitOps, observability, and zero stored credentials anywhere in the system.

---

## Slide 2 — The Problem: Why We Left EC2 Auto Scaling Groups

**Key Points (on screen):**
- **Deployments**: Engineers had to SSH into servers, pull code manually, restart processes
- **Credentials**: AWS access keys stored in `.env` files on servers — leaked = compromised forever
- **Scaling**: Adding a new VM takes 2–5 minutes — all services scale together, even when only one is busy
- **Downtime**: Restarting a service → downtime during the restart window
- **Config drift**: Servers diverge over time — "works on server 1, broken on server 2"

**Speaker Notes:**
Before this project, the application ran on EC2 instances behind an Auto Scaling Group. While this works, it has serious operational problems. Every deployment required SSHing into running servers, pulling the latest code, and restarting processes — which means downtime and human error. AWS credentials were stored in `.env` files directly on the servers. If a key leaked into logs or a developer accidentally committed it, that key was valid until someone manually rotated it. Scaling was also coarse — you had to add an entire new VM even if only the order service was under load. And over time, servers drift from each other because updates are applied manually one by one. The new EKS-based design solves all of these problems simultaneously.

---

## Slide 3 — Solution Overview: What We Built

**Key Points (on screen):**
- **3 Repositories**: `shopmesh-app` (code) · `shopmesh-gitops` (Helm/ArgoCD) · `shopmesh-terraform` (IaC)
- **Infrastructure**: 100% Terraform — 15 modules, remote state in S3, lock in DynamoDB
- **Platform**: Amazon EKS (Kubernetes 1.30) — 4 × t3.medium nodes
- **Delivery**: ArgoCD GitOps + GitHub Actions CI/CD with OIDC (zero stored AWS keys)
- **Core principle**: Git is the single source of truth — no manual kubectl in production

**Speaker Notes:**
The solution is built around three clear repositories, each with a single responsibility. The `shopmesh-app` repo holds all application source code. The `shopmesh-gitops` repo holds Helm charts and ArgoCD Application manifests — this is what ArgoCD reads to decide what to deploy. The `shopmesh-terraform` repo holds all AWS infrastructure as code. All AWS resources — the EKS cluster, the load balancer, the DynamoDB tables, the CloudFront distribution — are created and managed by Terraform. No manual clicking in the AWS console. The delivery pipeline uses GitHub Actions with OIDC authentication, which means there are no AWS access keys stored anywhere — not in GitHub Secrets, not on any server. ArgoCD continuously watches the gitops repo and automatically deploys any changes within 3 minutes of a git push.

---

## Slide 4 — Network Architecture: VPC Design

**Key Points (on screen):**
```
VPC: 10.0.0.0/16
├── Public Subnets  (10.0.1.0/24, 10.0.2.0/24)  → ALB + NAT Gateways
└── Private Subnets (10.0.10.0/24, 10.0.11.0/24) → EKS Nodes + All Pods
```
- Internet Gateway → public subnets only
- NAT Gateways (one per AZ) → pods can call out, cannot be reached from internet
- VPC Endpoints for DynamoDB + S3 → private traffic, no NAT cost
- Security Groups: ALB accepts 80/443 · Nodes accept from ALB SG only

**Speaker Notes:**
The network is built on a single VPC — 10.0.0.0/16 — split into public and private subnets across two availability zones. The public subnets hold the Application Load Balancer and the NAT Gateways. The private subnets hold every EKS worker node and every pod. This means no pod is ever directly reachable from the internet — an attacker would have to go through the ALB first. NAT Gateways allow pods to make outbound calls — to pull Docker images from ECR, to call DynamoDB — without exposing themselves to inbound connections. We also configured VPC endpoints for DynamoDB and S3 so that traffic to those services never leaves the AWS network and doesn't consume NAT Gateway bandwidth. Security groups act as the final firewall: the EKS nodes only accept traffic from the ALB's security group — nothing else can reach them.

---

## Slide 5 — AWS Infrastructure: 15 Services, Each With a Purpose

**Key Points (on screen):**

| Service | Resource | Why |
|---------|---------|-----|
| EKS | `shopmesh-prod` | Managed Kubernetes control plane |
| ALB | `shopmesh-external-alb` | Routes HTTP/HTTPS into the cluster |
| CloudFront | `E1N9Y9KYLN4Q4I` | Global CDN + HTTPS termination |
| DynamoDB | 3 tables (users/products/orders) | Serverless NoSQL, IAM-native access |
| SQS + SNS | Order queue + 2 topics | Async event-driven order processing |
| Bedrock | Nova Lite (cross-account) | AI shopping assistant |
| Secrets Manager | `shopmesh/jwt-secret` | Encrypted secret, no `.env` files |
| ECR | 6 registries | Private container image storage |

**Speaker Notes:**
Let me walk through the key AWS services. CloudFront sits at the global edge — it terminates HTTPS using an ACM certificate, caches static assets close to users worldwide, and forwards requests to the ALB. The ALB does path-based routing: `/grafana` goes to Grafana, everything else goes to the frontend. DynamoDB was chosen over RDS because it's fully serverless, scales automatically, and integrates natively with IAM — meaning we never need a database password. SQS decouples order placement from order processing: when a user places an order, the service writes to DynamoDB and puts a message in the queue immediately — the user gets a fast response while background processing continues asynchronously. AWS Secrets Manager stores the JWT signing key — no application ever has this key hardcoded or in an environment variable set by a human.

---

## Slide 6 — Infrastructure as Code: Terraform Workflow

**Key Points (on screen):**
```
terraform init     → Download providers, pull state from S3
terraform validate → Syntax + reference check (offline)
terraform plan     → Show what WILL change — no actual changes
terraform apply    → Execute changes in dependency order
```
- **15 modules**: vpc → security-groups → eks → irsa → alb → cloudfront → route53 → ...
- **Remote state**: S3 bucket (`shopmesh-terraform-state-242969680553`) + DynamoDB lock table
- **Module value flow**: outputs of one module become inputs of the next
- **Dependency graph**: Terraform auto-resolves order (VPC before EKS, EKS before IRSA)

**Speaker Notes:**
Terraform is the Infrastructure as Code tool that creates and manages every AWS resource. The workflow is always the same four steps. `terraform init` downloads the AWS provider plugin and pulls the latest state file from S3 — this state file is Terraform's memory of what it already created. `terraform validate` checks syntax without touching AWS — fast and safe. `terraform plan` is the most important step: it reads the current AWS state via API calls and shows exactly what will be created, changed, or destroyed before anything is touched. `terraform apply` then executes those changes in the correct order based on the dependency graph — it knows VPC must exist before EKS, and EKS must exist before IRSA, so it builds them in that sequence automatically. The DynamoDB lock table prevents two engineers from running `apply` at the same time, which would corrupt the state file.

---

## Slide 7 — EKS: The Kubernetes Cluster

**Key Points (on screen):**
- **Control plane**: AWS-managed (API server, scheduler, etcd) — zero maintenance
- **Worker nodes**: 4 × t3.medium (2 vCPU, 4GB RAM) — private subnets, 17-pod limit each
- **Scaling config**: min=2, desired=4, max=6 (auto-scalable)
- **5 Managed Add-ons**: `vpc-cni` · `coredns` · `kube-proxy` · `ebs-csi-driver` · `cloudwatch-observability`
- **OIDC Provider**: Foundation for IRSA — EKS registers as trusted identity provider in IAM

**Speaker Notes:**
Amazon EKS manages the Kubernetes control plane — the API server, the scheduler, the etcd database — on our behalf. We only manage the worker nodes. Four t3.medium EC2 instances run in the private subnets with 17 pods maximum per node — this limit comes from the VPC CNI plugin which assigns real VPC IP addresses to every pod. We actually hit this limit during the project when running 3 nodes — pods went Pending because there were no IPs left. Adding a fourth node immediately resolved it. The five managed add-ons handle critical cluster functions: vpc-cni assigns IPs to pods, coredns answers DNS queries between services, ebs-csi-driver creates EBS volumes when Prometheus or Grafana needs persistent storage, and the cloudwatch-observability add-on sends container metrics to CloudWatch. The OIDC Provider is the most important EKS resource for security — it's what makes IRSA possible, which we'll cover on the next slide.

---

## Slide 8 — IRSA: Zero Static Credentials, Everywhere

**Key Points (on screen):**
- **Old way** ❌: `AWS_ACCESS_KEY_ID` stored in `.env` — never expires, rotation is manual
- **IRSA way** ✅: Pod presents Kubernetes JWT → STS exchanges it for 15-min temporary credentials
- **11 IAM Roles** — one per service account, each with least-privilege permissions:
  - `auth-service` → DynamoDB (users table) + Secrets Manager (jwt-secret only)
  - `order-service` → DynamoDB (orders) + SQS + SNS
  - `ai-assistant` → STS AssumeRole (cross-account Bedrock, account `686591366739`)
  - `grafana` → CloudWatch read-only (metrics + logs for dashboards)
- Credentials auto-rotate every 15 minutes — zero manual rotation

**Speaker Notes:**
IRSA — IAM Roles for Service Accounts — is the most important security feature in this project. The old approach of storing AWS access keys in environment variables is dangerous because those keys never expire automatically. If a key leaks into a log file or a git commit, it's valid until someone notices and rotates it manually. With IRSA, no key is ever stored anywhere. When a pod starts, EKS automatically injects two environment variables: the IAM role ARN and the path to a short-lived JWT token. The AWS SDK inside the pod reads that JWT, sends it to AWS STS, and gets back temporary credentials that expire in 15 minutes. STS validates the JWT against the EKS OIDC provider and checks that the token belongs to the exact service account allowed in the role's trust policy. There are 11 separate roles — one per service — each scoped to only the AWS resources that specific service needs. The AI assistant service even does a cross-account role assumption to reach Amazon Bedrock in a separate AWS account.

---

## Slide 9 — The 6 Microservices: What Each One Does

**Key Points (on screen):**

| Service | Port | AWS Services Used |
|---------|------|-----------------|
| **frontend** | 80 | — (React + nginx, proxies to kgateway) |
| **auth-service** | 3001 | DynamoDB (users) + Secrets Manager (JWT key) |
| **product-service** | 3002 | DynamoDB (products) + S3 (images) + SNS |
| **order-service** | 3003 | DynamoDB (orders) + SQS + SNS + EventBridge |
| **analytics-service** | 3004 | DynamoDB (orders+products read) + CloudWatch |
| **ai-assistant-service** | 3005 | Bedrock Nova Lite (cross-account) |

- Each service: separate codebase, separate Docker image, separate IRSA role, separate DynamoDB table
- HPA on every service: min=2, max=6 replicas, scales on CPU 60% / memory 75%

**Speaker Notes:**
The application is split into 6 microservices, each independently deployable and scalable. The frontend is a React single-page application served by nginx. nginx is responsible for two things: serving the static React files to the browser, and proxying all API calls internally to kgateway — the internal service router. The auth-service handles user registration and login, issuing JWT tokens signed with a key fetched from AWS Secrets Manager. The product-service manages the product catalog and stores images in S3. The order-service creates orders in DynamoDB, puts them on an SQS queue for async processing, and publishes events to SNS. The analytics-service reads order and product data to generate reports and publishes custom metrics to CloudWatch. The AI assistant calls Amazon Bedrock's Nova Lite model — specifically in a cross-account setup where Bedrock is enabled in a separate AWS account. Every service runs a minimum of 2 replicas for high availability and scales automatically with the Horizontal Pod Autoscaler.

---

## Slide 10 — Internal Traffic Flow: A Request End-to-End

**Key Points (on screen):**
```
Browser (HTTPS)
  → Route53 DNS → CloudFront (edge, TLS termination, /api/* no cache)
  → ALB (path-based routing: /grafana → Grafana TG, else → Frontend TG)
  → Frontend Pod (nginx) → proxy_pass to kgateway (Envoy proxy)
  → kgateway HTTPRoute → order-service:3003
  → order-service: validate JWT · write DynamoDB · send SQS · publish SNS
  → SNS → EventBridge → alert if order value > threshold
  → Response: 201 Created ← reverse path ← browser
```
- All internal hops use Kubernetes DNS (`service.namespace.svc.cluster.local`)
- API calls NEVER leave the VPC after CloudFront → ALB

**Speaker Notes:**
Let me walk through what happens when a user clicks "Place Order". The browser sends an HTTPS POST to shopmesh.shop. Route53 resolves the domain to CloudFront. CloudFront terminates TLS using our ACM certificate, identifies the `/api/orders` path as matching the `/api/*` behavior — which disables caching and forwards all cookies and headers — then sends the request over HTTP to the ALB inside the AWS network. The ALB evaluates its listener rules: since this isn't a `/grafana` path, it sends it to the frontend target group, which contains the frontend pod IPs. The frontend nginx receives the request, matches the `/api/orders` location block, and proxies it to the kgateway Envoy proxy using Kubernetes DNS. kgateway reads its HTTPRoute rules and forwards to the order-service pod. The order-service validates the user's JWT by calling auth-service internally, writes the order to DynamoDB using IRSA credentials, puts a message on SQS for async processing, and publishes an event to SNS. EventBridge picks up the SNS event and can route high-value orders to alert subscribers. The entire backend path never leaves the AWS VPC.

---

## Slide 11 — Helm + ArgoCD: GitOps in Practice

**Key Points (on screen):**
- **Helm**: Template engine for Kubernetes YAML — one chart template, values per service
- **ArgoCD — App-of-Apps pattern**:
  ```
  root-application (applied once manually)
    └── watches: applications/ directory
         ├── infrastructure/ (monitoring, kgateway, ALBC, ESO, Fluent Bit...)
         └── services/ (frontend, auth, products, orders, analytics, ai-assistant)
  ```
- **Sync cycle**: ArgoCD polls gitops repo every 3 min → renders Helm → diffs against live cluster → applies
- **selfHeal: true** → manual kubectl changes reverted within 3 minutes
- **Git = truth**: no manual apply in production, ever

**Speaker Notes:**
Helm is the package manager for Kubernetes — instead of writing 8 nearly-identical YAML files for each of 6 services, we write templates once with placeholder variables like `{{ .Values.service.port }}` and provide a `values.yaml` file per service. ArgoCD is the GitOps controller — it runs inside the cluster and continuously ensures the cluster matches what's in the shopmesh-gitops repository. The App-of-Apps pattern means we applied exactly one manifest manually to bootstrap the system. That root application watches the `applications/` directory and automatically creates ArgoCD Application resources for every file it finds — one for monitoring, one for each microservice, one for kgateway, and so on. Each of those Applications then watches its own Helm chart directory. When ArgoCD detects a difference — for example, a new image tag in values.yaml after a CI deploy — it automatically applies the change and Kubernetes performs a rolling update with zero downtime. The `selfHeal: true` setting means if an engineer accidentally runs kubectl directly on the cluster and changes something, ArgoCD reverts it within 3 minutes. Git is always the truth.

---

## Slide 12 — CI/CD Pipeline: From Code Push to Running Pod

**Key Points (on screen):**
```
1. Developer pushes to main branch
2. GitHub Actions triggers:
   a. GitHub OIDC → AWS STS → Temporary credentials (NO stored keys)
   b. Trivy security scan — blocks on HIGH/CRITICAL CVEs
   c. docker build → image tagged with git commit SHA (e.g., 40ddaf5)
   d. docker push → ECR (242969680553.dkr.ecr.us-east-1.amazonaws.com)
   e. sed -i "s/tag:.*/tag: 40ddaf5/" charts/auth-service/values.yaml
   f. git push → shopmesh-gitops
3. ArgoCD detects new tag → rolling update → zero downtime
```
- PR checks block merge on: build failure · Trivy CVEs · Helm lint errors
- Terraform CI: separate role, plan posted as PR comment, apply requires manual approval

**Speaker Notes:**
The CI/CD pipeline is fully automated from code push to running pod. When a developer merges a pull request, GitHub Actions kicks off. The first thing it does is authenticate with AWS using GitHub OIDC — no access key is stored in GitHub Secrets. GitHub generates a short-lived JWT proving "this workflow is running in the shopmesh-final/shopmesh-app repo", AWS STS validates it and returns temporary credentials valid for one hour. Next, Trivy scans the Docker image for known security vulnerabilities. If any HIGH or CRITICAL CVE is found, the pipeline stops and the merge is blocked. If the scan passes, the image is built and tagged with the seven-character git commit SHA — this makes every image uniquely traceable back to the exact code change that created it. The image is pushed to ECR, and then the pipeline updates the `values.yaml` in the gitops repo with the new image tag. ArgoCD picks this up within 3 minutes and performs a rolling update — new pods with the new image come up one at a time, pass health checks, and old pods are terminated. Users experience zero downtime.

---

## Slide 13 — Monitoring: Prometheus, Grafana, Alerts

**Key Points (on screen):**
- **kube-prometheus-stack v65.1.1** deployed via ArgoCD into `monitoring` namespace
- **Prometheus**: scrapes metrics every 30s from all pods, nodes, Kubernetes API — 7-day retention on 5Gi EBS
- **Grafana** at https://shopmesh.shop/grafana — 2 dashboard folders:
  - *ShopMesh Kubernetes*: Node Exporter Full, K8s Overview, Workloads, ArgoCD
  - *ShopMesh AWS*: ALB metrics, EKS CPU, AI Assistant request count — from CloudWatch via IRSA
- **Dashboard sources**: community gnetId downloads + ConfigMap sidecar + direct datasource provisioning
- **PrometheusRules**: NodeNotReady · PodCrashLoopBackOff · ApplicationDown (after 5 min)

**Speaker Notes:**
The monitoring stack is built on kube-prometheus-stack, which installs Prometheus, Grafana, AlertManager, node-exporter, and kube-state-metrics together as a single Helm release. Prometheus scrapes metrics every 30 seconds from a Prometheus Operator watches ServiceMonitor and PodMonitor CRDs — when you deploy a new service, you just create a PodMonitor and Prometheus automatically discovers it. Grafana is accessible at shopmesh.shop/grafana and has two dashboard folders. The Kubernetes folder shows node CPU, pod restarts, deployment replica counts, and ArgoCD sync status. The AWS folder shows CloudFront request rates, ALB 5xx errors, EKS node CPU, and the AI assistant Bedrock call frequency. The CloudWatch panels work because Grafana's pod has an IRSA role giving it read-only CloudWatch access — no AWS credentials are configured in Grafana at all. We hit an interesting bug with kube-prometheus-stack v65 where it created two Prometheus datasource files simultaneously, both marked as default — Grafana crashed with "only one default datasource allowed." The fix was disabling the datasource sidecar container to remove the duplicate.

---

## Slide 14 — Logging: Fluent Bit to CloudWatch

**Key Points (on screen):**
- **Fluent Bit** deployed as a **DaemonSet** — 1 pod per node, guaranteed
- Reads `/var/log/containers/*.log` — captures stdout/stderr from every container
- Ships to **CloudWatch Logs**: log group `/shopmesh/eks`, one stream per pod
- Uses **IRSA** (`shopmesh-irsa-fluent-bit`) — no CloudWatch credentials stored
- **Grafana CloudWatch datasource** queries logs directly:
  ```
  filter @logStream like /ai-assistant/
  | stats count() as calls by bin(1m)
  ```
- Full audit trail: every request, error, and Bedrock API call is searchable in CloudWatch

**Speaker Notes:**
Log management is handled by Fluent Bit, deployed as a DaemonSet which Kubernetes guarantees runs exactly one copy on every worker node. Fluent Bit reads the container log files that the container runtime writes to disk, parses them, adds metadata like namespace, pod name, and container name, then streams them to CloudWatch Logs using its IRSA role — no credentials stored. Every pod's logs land in the `/shopmesh/eks` log group with a stream per pod. This means if a user reports an error at 2:14pm, I can go to CloudWatch Logs Insights and search across all services simultaneously with a single query rather than SSH-ing into individual servers. The Grafana AI assistant dashboard panel actually uses CloudWatch Logs Insights to count how many times the AI assistant calls Bedrock per minute. This creates a complete observability loop: the application logs the event, Fluent Bit ships it to CloudWatch, and Grafana visualizes it in real time — all automated, all using IRSA.

---

## Slide 15 — Key Outcomes & Lessons Learned

**Key Points (on screen):**
- ✅ **Zero static AWS credentials** — IRSA for every pod, OIDC for CI/CD, ESO for secrets
- ✅ **Full GitOps** — push to git → ArgoCD deploys in <3 min, no manual kubectl in production
- ✅ **Live application** — https://shopmesh.shop, 6 services, Grafana dashboards with real data
- ✅ **Complete IaC** — 15 Terraform modules, reproducible from scratch in one `terraform apply`
- ✅ **Observability** — Prometheus metrics, CloudWatch logs, Grafana dashboards, alert rules

**Key Lessons:**
- Pod IP limits on t3.medium (17 pods) are a real operational constraint — plan node sizing early
- CloudFront cookie forwarding must be configured per path — missing it broke Grafana login (CSRF)
- kube-prometheus-stack v65 dual-datasource bug: always pin chart versions AND read changelogs

**Speaker Notes:**
To wrap up — ShopMesh achieves its three core goals. First, zero static credentials: every service uses IRSA, the CI pipeline uses GitHub OIDC, secrets come from AWS Secrets Manager via External Secrets Operator. No AWS access key exists anywhere in the system. Second, full GitOps: the cluster's state is always driven by what's in the git repository. ArgoCD enforces this continuously. Third, a working, observable application: you can visit shopmesh.shop right now and all six services are running with live Grafana dashboards showing their health. In terms of lessons learned — the three biggest surprises were the t3.medium pod limit forcing us to scale from 3 to 4 nodes mid-project, a CloudFront cookie forwarding misconfiguration that broke Grafana's login because CSRF tokens weren't being passed, and a kube-prometheus-stack v65 bug that caused a CrashLoopBackOff until we disabled the duplicate datasource sidecar. Each of these was a real production-style problem that forced us to dig into AWS, Kubernetes, and Helm internals to solve. Thank you — happy to answer any questions.

---

*Presentation prepared for ShopMesh Capstone — June 2026*
*Live app: https://shopmesh.shop · Grafana: https://shopmesh.shop/grafana*
