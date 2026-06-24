# ShopMesh — Complete Project Reference

> Written so that anyone — even someone reading this for the first time — can understand what every component does, why it was chosen, how it connects to everything else, and what would break without it.

---

## Table of Contents

1. [What Is ShopMesh?](#1-what-is-shopmesh)
2. [Big Picture — How Everything Connects](#2-big-picture--how-everything-connects)
3. [Network Architecture — VPC, Subnets, and Why](#3-network-architecture--vpc-subnets-and-why)
4. [Infrastructure Architecture — Every AWS Service](#4-infrastructure-architecture--every-aws-service)
5. [Terraform — How Infrastructure Is Built](#5-terraform--how-infrastructure-is-built)
6. [EKS — The Kubernetes Cluster](#6-eks--the-kubernetes-cluster)
7. [IRSA — How Pods Get AWS Permissions](#7-irsa--how-pods-get-aws-permissions)
8. [Helm — Packaging Kubernetes Applications](#8-helm--packaging-kubernetes-applications)
9. [ArgoCD — GitOps and Automated Deployments](#9-argocd--gitops-and-automated-deployments)
10. [CI/CD Pipeline — From Code to Running Pod](#10-cicd-pipeline--from-code-to-running-pod)
11. [Microservices — What They Do and How They Talk](#11-microservices--what-they-do-and-how-they-talk)
12. [kgateway — Internal Service Router](#12-kgateway--internal-service-router)
13. [AWS Load Balancer Controller and TargetGroupBinding](#13-aws-load-balancer-controller-and-targetgroupbinding)
14. [External Secrets Operator — Secrets Without Secrets in Code](#14-external-secrets-operator--secrets-without-secrets-in-code)
15. [Monitoring — Prometheus and Grafana](#15-monitoring--prometheus-and-grafana)
16. [Logging — Fluent Bit to CloudWatch](#16-logging--fluent-bit-to-cloudwatch)
17. [Security Architecture](#17-security-architecture)
18. [Key References — URLs, Credentials, ARNs](#18-key-references--urls-credentials-arns)

---

## 1. What Is ShopMesh?

ShopMesh is a **cloud-native e-commerce platform** running entirely on AWS. It is built as a capstone project that demonstrates how a real production system is designed, deployed, and operated — migrating away from old-style EC2 virtual machines into modern Kubernetes on Amazon EKS.

### What does it do?

ShopMesh allows users to:
- Browse products (with images stored in S3)
- Create accounts and log in (JWT authentication)
- Place orders
- View analytics on order activity
- Chat with an AI shopping assistant powered by Amazon Bedrock

### Why was it redesigned from EC2 to EKS?

| Old way (EC2 ASG) | New way (EKS) |
|------------------|--------------|
| Deploy by SSHing into servers | Deploy by pushing to git — ArgoCD handles the rest |
| Scale by adding whole VMs (slow, 2-5 min) | Scale by adding pods (fast, 10-30 sec) |
| Each service runs on dedicated VMs (wasteful) | Services share node resources efficiently |
| Credentials stored in `.env` files on servers | Zero stored credentials — IRSA gives temporary AWS access |
| Manual updates — login, pull, restart | Automatic rolling updates — zero downtime |
| No standardized config per environment | Helm values files per environment |

### Three Repositories

The project is split across three separate git repositories, each with a distinct responsibility:

| Repository | What lives there | Who/what reads it |
|-----------|-----------------|------------------|
| `shopmesh-app` | Source code for all 6 microservices + Dockerfiles | Developers + CI/CD pipeline |
| `shopmesh-gitops` | Helm charts, ArgoCD Application manifests, kgateway routes | ArgoCD (reads continuously) |
| `shopmesh-terraform` (TF-Shopemesh) | All AWS infrastructure as Terraform code | Engineers + Terraform CI pipeline |

**Why split into 3 repos?** App code changes frequently (multiple times per day). Infrastructure changes rarely (weekly/monthly). GitOps config changes on each deploy. Mixing them would make history messy and permissions hard to control. Each repo has its own CI pipeline and its own set of permissions.

### Core Design Rules (never break these)

- **No static AWS credentials anywhere** — not in environment variables, not in ConfigMaps, not in `.env` files, not in GitHub secrets. All AWS access is through IRSA (temporary, auto-rotating).
- **No `kubectl apply` in production by hand** — ArgoCD is the only thing that applies manifests. Manual kubectl changes get overwritten within 3 minutes.
- **Secrets only through AWS Secrets Manager** — fetched into the cluster by External Secrets Operator, never written by a human.
- **GitHub Actions never stores AWS keys** — uses GitHub OIDC to get temporary credentials instead.

---

## 2. Big Picture — How Everything Connects

Before diving into each component, here is the complete path a user request travels — from their browser to the database and back:

```
USER'S BROWSER
     │
     │  HTTPS request to https://shopmesh.shop/api/orders
     │
     ▼
ROUTE53 (DNS)
     │  "shopmesh.shop" → points to CloudFront distribution
     │  (A alias record, no TTL issues)
     ▼
CLOUDFRONT (Global CDN — Edge Location nearest to user)
     │  • Terminates HTTPS using ACM certificate (*.shopmesh.shop)
     │  • Decides caching behavior based on path:
     │     /api/*    → forward ALL cookies + headers, no cache
     │     /grafana* → forward ALL cookies + headers, no cache
     │     /static/* → cache for 1 year (hashed filenames)
     │     default   → no cache (frontend HTML)
     │  • Forwards request to origin (the ALB) over HTTP
     ▼
APPLICATION LOAD BALANCER (shopmesh-external-alb)
     │  • Lives in public subnets (internet-reachable)
     │  • Listener rules (evaluated in order by priority):
     │     Priority 100: /grafana or /grafana/* → shopmesh-grafana-tg
     │     Default:      everything else         → shopmesh-frontend-tg
     ▼
FRONTEND POD (nginx, port 80, private subnet)
     │  • ALB registered this pod's IP via TargetGroupBinding
     │  • nginx serves the React app's static files (index.html, JS, CSS)
     │  • For /api/* paths, nginx proxies internally to kgateway:
     │
     │    proxy_pass http://prod.kgateway-system.svc.cluster.local:80
     │
     ▼
KGATEWAY (Envoy proxy — internal API router, same cluster)
     │  • Reads HTTPRoute resources to know where to forward
     │  • Routes based on path prefix:
     │     /api/auth      → auth-service:3001
     │     /api/products  → product-service:3002
     │     /api/orders    → order-service:3003
     │     /api/analytics → analytics-service:3004
     │     /api/assistant → ai-assistant-service:3005
     ▼
MICROSERVICE POD (e.g., order-service, port 3003)
     │  • Uses IRSA to call AWS services without stored credentials
     │  • Reads/writes DynamoDB
     │  • Publishes events to SQS / SNS
     │  • Calls other microservices via internal DNS
     ▼
AWS SERVICES (DynamoDB, SQS, SNS, S3, Bedrock, Secrets Manager)
     │
     └── Response travels back the same path in reverse
```

---

## 3. Network Architecture — VPC, Subnets, and Why

### What is a VPC and why does it matter?

A VPC (Virtual Private Cloud) is a logically isolated network inside AWS. Think of it as building your own private data center network inside AWS's infrastructure. Without a VPC, every EC2 instance and EKS node would be directly exposed to the internet.

### ShopMesh VPC Layout

```
VPC: shopmesh-prod-vpc
CIDR Block: 10.0.0.0/16
(This means IPs from 10.0.0.1 to 10.0.255.254 — 65,534 possible addresses)

┌─────────────────────────────────────────────────────────────────┐
│                        VPC 10.0.0.0/16                          │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │   PUBLIC SUBNET 1a   │  │   PUBLIC SUBNET 1b   │            │
│  │   10.0.1.0/24        │  │   10.0.2.0/24        │            │
│  │   (us-east-1a)       │  │   (us-east-1b)       │            │
│  │                      │  │                      │            │
│  │  • ALB nodes         │  │  • ALB nodes         │            │
│  │  • NAT Gateway       │  │  • NAT Gateway       │            │
│  └──────────┬───────────┘  └──────────┬───────────┘            │
│             │                          │                         │
│             │  (internet traffic in)   │                         │
│             ▼                          ▼                         │
│       Internet Gateway (IGW)                                     │
│             │                                                     │
│             ▼ (outbound only for private subnets)                │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │  PRIVATE SUBNET 1a   │  │  PRIVATE SUBNET 1b   │            │
│  │  10.0.10.0/24        │  │  10.0.11.0/24        │            │
│  │  (us-east-1a)        │  │  (us-east-1b)        │            │
│  │                      │  │                      │            │
│  │  • EKS worker nodes  │  │  • EKS worker nodes  │            │
│  │  • All pods          │  │  • All pods          │            │
│  │  • No inbound from   │  │  • No inbound from   │            │
│  │    internet          │  │    internet          │            │
│  └──────────────────────┘  └──────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Why Public vs Private Subnets?

**Public subnets** have a route to the Internet Gateway — traffic can flow in and out directly. This is where the **ALB** lives because it needs to receive traffic from the internet.

**Private subnets** have NO route to the Internet Gateway. EKS nodes live here because:
- If a pod is compromised, the attacker cannot directly reach it from the internet
- Nodes can still make outbound calls (to ECR to pull images, to DynamoDB, etc.) via the **NAT Gateway**

### NAT Gateway — Why One Per AZ?

The NAT Gateway (Network Address Translation) sits in the public subnet and allows private-subnet resources to make outbound internet connections (e.g., pulling Docker images from ECR, calling external APIs) without being reachable from outside.

There is one NAT Gateway per availability zone because:
- If you have only one NAT GW in `us-east-1a` and that AZ has an outage, nodes in `us-east-1b` lose internet access
- Two NAT GWs cost more but eliminate that cross-AZ failure mode

### VPC Endpoints — Why?

Without VPC endpoints, every call from a pod to DynamoDB or S3 would leave the VPC, travel over the internet (via NAT Gateway), reach the AWS service, and come back. This costs money (NAT Gateway data processing charges) and is slower.

VPC Endpoints create a **private route** inside AWS's network:
```
Pod → VPC Endpoint (private) → DynamoDB   (no NAT Gateway, no internet, no cost)
```

Two Gateway-type VPC endpoints are configured:
- `com.amazonaws.us-east-1.dynamodb` — all DynamoDB calls stay private
- `com.amazonaws.us-east-1.s3` — all S3 calls stay private

### Security Groups — The Firewall Layer

Security groups act as stateful firewalls attached to resources. ShopMesh uses:

**ALB Security Group (`shopmesh-alb-sg`)**:
- Inbound: port 80 from 0.0.0.0/0 (everyone) — accepts HTTP from CloudFront
- Inbound: port 443 from 0.0.0.0/0 (everyone) — accepts HTTPS from CloudFront
- Outbound: all traffic (ALB needs to reach pods)

**EKS Node/Cluster Security Group**:
- Inbound port 80: only from the ALB security group (frontend pods)
- Inbound port 3000: only from the ALB security group (Grafana pod)
- Inbound all ports: from within the cluster (pod-to-pod communication)
- No direct inbound from the internet

This means even if someone found the ALB's IP and tried to bypass CloudFront to reach pods directly — they'd be blocked at the security group unless they're coming through the ALB.

### Subnet Tags — Why EKS Needs Them

EKS requires specific tags on subnets so it knows which subnets to use:
```
Public subnets:  kubernetes.io/role/elb = "1"
                 (ALB can be placed here)
Private subnets: kubernetes.io/role/internal-elb = "1"
                 (Internal load balancers go here)
Both:            kubernetes.io/cluster/shopmesh-prod = "shared"
                 (EKS recognizes these as part of its cluster)
```

Without these tags, the AWS Load Balancer Controller cannot discover which subnets to place load balancers in.

---

## 4. Infrastructure Architecture — Every AWS Service

### Complete AWS Service Map

| Service | Exact Resource Name | Why It's Used |
|---------|-------------------|--------------|
| **EKS** | `shopmesh-prod` | Managed Kubernetes control plane — runs all containers |
| **EC2 Managed Node Group** | `shopmesh-prod-nodes` (t3.medium × 4) | The actual VMs where pods run |
| **ALB** | `shopmesh-external-alb` | Routes external HTTP/HTTPS traffic into the cluster |
| **CloudFront** | `E1N9Y9KYLN4Q4I` | Global CDN — HTTPS termination, edge caching, distributes traffic globally |
| **Route53** | Hosted zone `shopmesh.shop` | DNS — translates domain name to CloudFront IP |
| **ACM** | 2 certificates | TLS certificates for HTTPS (one for ALB, one for CloudFront — must be in us-east-1) |
| **ECR** | `shopmesh/frontend`, `shopmesh/auth-service`, etc. | Private Docker image registry — stores built container images |
| **DynamoDB** | `shopmesh-users`, `shopmesh-products`, `shopmesh-orders` | NoSQL database — stores all application data |
| **S3** | `shopmesh-product-images-242969680553` | Object storage — product images, ALB access logs, CloudFront logs |
| **SQS** | `shopmesh-order-processing` + DLQ | Message queue — decouples order placement from order processing |
| **SNS** | `shopmesh-orders`, `shopmesh-alerts` | Pub/Sub — broadcasts events to multiple subscribers |
| **EventBridge** | Rule-based | Routes order events from SNS to alert channels conditionally |
| **Secrets Manager** | `shopmesh/jwt-secret` | Encrypted secret storage for the JWT signing key |
| **CloudWatch** | Log group `/shopmesh/eks` | Centralized logging + metrics + alarms |
| **Bedrock** | `amazon.nova-lite-v1:0` (cross-account) | AI model for the shopping assistant |
| **IAM** | 11 IRSA roles + 2 GitHub Actions roles | Fine-grained AWS permissions per service |

### Why DynamoDB Instead of RDS?

DynamoDB (NoSQL) was chosen over RDS (relational SQL) because:
- **No server to manage** — fully serverless, scales automatically
- **Sub-millisecond reads** — ideal for product catalog and user session lookups
- **Pay per request** — no minimum cost for a demo/capstone project
- **Works perfectly with IRSA** — IAM-native access control, no password to manage

Trade-off: DynamoDB has no JOIN queries. Each table is designed to be queried by a single key pattern. The three tables (`users`, `products`, `orders`) each serve one service and one access pattern.

### Why SQS for Order Processing?

When a user places an order, two things must happen: the order is recorded, AND downstream processing happens (inventory update, email notification, analytics). Doing all of this synchronously inside the HTTP request would:
- Make the user wait for ALL of it to complete
- If the email system is slow or down, the whole order fails

With SQS:
```
User clicks "Place Order"
    ↓ (synchronous — user waits for this)
order-service writes order to DynamoDB
order-service sends message to SQS queue
    ↓ (response sent immediately: "Order confirmed!")
    
(asynchronously, in background)
Queue processor reads message from SQS
Does slow/fragile work: sends email, updates analytics, etc.
If it fails → message goes to Dead Letter Queue for retry
```

The Dead Letter Queue (DLQ) is a safety net — if a message fails processing 3 times, it moves to the DLQ so engineers can inspect it and retry manually, rather than the message being lost forever.

### Why Two ACM Certificates?

CloudFront is a **global** service. Its configuration must reference an ACM certificate in **us-east-1** specifically — this is an AWS hard requirement, regardless of where your other resources are. The ALB has its own separate certificate in the same region (also us-east-1 in this project). Two separate certificates are created even though they cover the same domain (`shopmesh.shop`), because they are attached to different resources.

---

## 5. Terraform — How Infrastructure Is Built

### What Is Terraform and Why Use It?

Terraform is **Infrastructure as Code** — instead of clicking through the AWS console to create resources, you write code that describes what you want. Terraform reads that code and makes the AWS API calls to create/update/delete resources.

Benefits:
- **Reproducibility**: run the same code in a new account → identical infrastructure
- **Version control**: infrastructure changes are tracked in git like any other code
- **Dependency management**: Terraform automatically knows "create VPC before EKS because EKS needs the VPC ID"
- **Safe updates**: `terraform plan` shows exactly what will change before any change is made

### Repository File Structure

```
TF-Shopemesh/terraform/
│
├── main.tf              ← ROOT module — calls all child modules, glues everything together
├── variables.tf         ← Declares all input variables (name, type, description, default)
├── terraform.tfvars     ← Actual values for variables (project_name, region, node sizes, etc.)
├── outputs.tf           ← Values to expose after apply (ARNs, DNS names used by CI/CD)
├── versions.tf          ← Pins the exact Terraform and provider versions to use
├── providers.tf         ← AWS provider config (region, plus a secondary "us_east_1" alias for CF cert)
├── github-oidc.tf       ← Creates GitHub Actions OIDC provider + IAM roles for CI/CD
│
└── modules/
    ├── vpc/             ← VPC, 4 subnets, IGW, 2 NAT Gateways, route tables, VPC endpoints
    ├── security-groups/ ← ALB security group (80 + 443 inbound)
    ├── eks/             ← EKS cluster, managed node group, OIDC provider, 5 add-ons
    ├── irsa/            ← 11 IAM roles (one per service account) with OIDC trust policies
    ├── alb/             ← ALB, 2 target groups, HTTP/HTTPS listeners, listener rules
    ├── cloudfront/      ← CloudFront distribution with 4 cache behaviors
    ├── route53/         ← Hosted zone, DNS validation CNAMEs, A alias records
    ├── s3/              ← Product images bucket, ALB log bucket, CloudFront log bucket
    ├── dynamodb/        ← 3 DynamoDB tables with on-demand billing
    ├── secretsmanager/  ← JWT secret placeholder (populated manually once)
    ├── sns/             ← 2 SNS topics: orders + alerts
    ├── sqs/             ← Order processing queue + DLQ with redrive policy
    ├── ecr/             ← 6 container registries (one per microservice)
    ├── cloudwatch/      ← Log groups, metric alarms, Container Insights dashboard
    └── eventbridge/     ← Event routing rules (SNS orders → alerts topic conditionally)
```

### Step 1 — `terraform init` (One-Time Setup Per Machine)

```bash
cd TF-Shopemesh/terraform
terraform init
```

**What happens internally, in order:**

1. **Reads `versions.tf`** to know which provider to download:
   ```hcl
   terraform {
     required_providers {
       aws = { source = "hashicorp/aws", version = "~> 5.0" }
     }
   }
   ```

2. **Downloads the AWS provider plugin** into `.terraform/providers/registry.terraform.io/hashicorp/aws/5.x.x/`. This is what translates `aws_eks_cluster` into actual AWS API calls.

3. **Reads the backend configuration** (S3 backend for remote state):
   ```hcl
   terraform {
     backend "s3" {
       bucket         = "shopmesh-terraform-state-242969680553"
       key            = "shopmesh/terraform.tfstate"
       region         = "us-east-1"
       dynamodb_table = "shopmesh-terraform-locks"
       encrypt        = true
     }
   }
   ```
   This tells Terraform: "Don't store state locally on my laptop — store it in S3 so the team shares it."

4. **Downloads the state file** from S3. This file is Terraform's memory of what it has already created.

5. **Creates `.terraform.lock.hcl`** which pins the exact provider version (e.g., `5.56.1`). This prevents "works on my machine" problems where different engineers use different provider versions.

**Bootstrap prerequisite**: Before `terraform init` can work, the S3 state bucket and DynamoDB lock table must already exist. These were created by a one-time bootstrap script run before any other infrastructure. You cannot store Terraform state in S3 until S3 exists.

### Step 2 — `terraform validate` (Syntax + Logic Check)

```bash
terraform validate
```

Terraform reads every `.tf` file in the root module AND all child modules and checks:
- **HCL syntax**: no missing braces, no typos in resource type names
- **Variable references**: every `var.something` must be declared in `variables.tf`
- **Output references**: `module.vpc.vpc_id` must be an actual output of the vpc module
- **Required arguments**: if `aws_eks_cluster` requires `role_arn`, it must be present

This does **not** call any AWS APIs — it is purely offline code checking. Fast (< 5 seconds).

### Step 3 — `terraform plan` (Shows What Will Change)

```bash
terraform plan
# For targeted changes:
terraform plan -target=module.alb.aws_lb_target_group.grafana
```

**Detailed internals:**

1. **Load state from S3**: Terraform knows what it created last time.
2. **Refresh**: For each resource in the state, Terraform calls AWS (`DescribeVpc`, `DescribeCluster`, etc.) to check if it still exists and if its attributes match.
3. **Compare desired (`.tf` code) vs actual (AWS APIs)**:
   - Resource in code but not in AWS → `+ create`
   - Resource in both but attributes differ → `~ update in-place` or `-/+ destroy and recreate`
   - Resource in state but removed from code → `- destroy`
4. **Output the diff**: Shows exactly what will change, with old and new values for each attribute.
5. **Does NOT make any changes**.

Example plan output (adding the Grafana target group):
```
+ aws_lb_target_group.grafana
  + name         = "shopmesh-grafana-tg"
  + port         = 3000
  + protocol     = "HTTP"
  + target_type  = "ip"
  + vpc_id       = "vpc-0abc123..."
  
+ aws_lb_listener_rule.grafana_https
  + priority     = 100
  + action.type  = "forward"
  
Plan: 3 to add, 0 to change, 0 to destroy.
```

### Step 4 — `terraform apply` (Makes the Real Changes)

```bash
terraform apply -auto-approve
# Or with manual confirmation:
terraform apply
# Type "yes" when prompted
```

**What happens:**

1. Runs `terraform plan` internally first (same diff calculation).
2. Builds a **dependency graph** (DAG — Directed Acyclic Graph). Resources that depend on others must be created after. Terraform parallelizes independent resources.
3. Creates/updates/deletes resources in the correct order, calling AWS APIs.
4. **After each resource succeeds**: writes the new state to S3 immediately. If Terraform crashes halfway through, the state is not corrupted — it reflects exactly what was created.
5. **Acquires DynamoDB lock at start**: prevents two engineers from running `apply` at the same time, which would corrupt state. The lock is released when apply finishes.

### Module Dependency Graph (The Build Order)

```
github-oidc.tf                   ← independent, runs first or in parallel

module.vpc                        ← builds the network foundation
    ↓ (outputs: vpc_id, subnet IDs)
module.security_groups            ← needs vpc_id to create SG in the right VPC
    ↓ (outputs: alb_sg_id)
module.eks                        ← needs subnet IDs (where to put nodes) + SG
    ↓ (outputs: oidc_provider_arn, cluster_sg_id, cluster_endpoint)
module.irsa                       ← needs oidc_provider_arn to build trust policies
    ↓ (outputs: all 11 role ARNs)
module.alb                        ← needs vpc_id, subnet IDs, certificate ARN, SG
    │   └── aws_sg_rule.alb_to_grafana  ← needs ALB SG + EKS cluster SG IDs
    ↓ (outputs: alb_dns_name, TG ARNs)
module.cloudfront                 ← needs alb_dns_name as its origin
    ↓ (outputs: cloudfront_domain_name, distribution_id)
module.route53                    ← needs cloudfront_domain_name for alias record
```

Everything else (DynamoDB, S3, SQS, SNS, ECR, Secrets Manager) is independent of EKS and runs in parallel with the main chain above.

### How Values Flow Between Modules (Real Example)

This is one of the most important things to understand about Terraform modules. Each module is a black box — it only receives what you explicitly pass in and only exposes what it explicitly outputs.

**Tracing `eks_node_desired_size = 4` from tfvars to AWS:**

```
File 1: terraform.tfvars
  eks_node_desired_size = 4          ← Engineer changes this file

File 2: variables.tf (root)
  variable "eks_node_desired_size" {
    description = "Desired EKS node count"
    type        = number
    default     = 3
  }

File 3: main.tf (root)
  module "eks" {
    source            = "./modules/eks"
    node_desired_size = var.eks_node_desired_size   ← passes 4 into the module
    ...
  }

File 4: modules/eks/variables.tf
  variable "node_desired_size" {
    type = number
  }

File 5: modules/eks/main.tf
  resource "aws_eks_node_group" "main" {
    scaling_config {
      desired_size = var.node_desired_size   ← AWS API receives: desired_size=4
    }
  }
```

**Tracing how IRSA gets the EKS OIDC provider ARN:**

```
modules/eks/main.tf:
  resource "aws_iam_openid_connect_provider" "eks" {
    url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
    client_id_list  = ["sts.amazonaws.com"]
    thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  }

modules/eks/outputs.tf:
  output "oidc_provider_arn" {
    value = aws_iam_openid_connect_provider.eks.arn
  }
  output "cluster_oidc_issuer_url" {
    value = aws_eks_cluster.main.identity[0].oidc[0].issuer
  }

main.tf (root):
  module "irsa" {
    source            = "./modules/irsa"
    oidc_provider_arn = module.eks.oidc_provider_arn        ← consumed here
    oidc_issuer_url   = module.eks.cluster_oidc_issuer_url  ← consumed here
  }
```

Terraform enforces this: you cannot use `module.eks.oidc_provider_arn` in `main.tf` unless the eks module explicitly declares that output. This makes dependencies explicit and prevents accidental coupling.

---

## 6. EKS — The Kubernetes Cluster

### What Is EKS?

Amazon EKS (Elastic Kubernetes Service) is a managed Kubernetes service. Kubernetes is the system that runs and manages containers at scale. EKS means AWS manages the Kubernetes **control plane** (the brain — API server, scheduler, etcd database) for you. You only manage the **worker nodes** (the VMs where your containers actually run).

Without EKS you would have to:
- Install and configure Kubernetes yourself on EC2 instances
- Set up etcd (Kubernetes's database) with high availability
- Handle Kubernetes version upgrades manually
- Monitor the control plane health yourself

With EKS, AWS handles all of that. You just define worker nodes and deploy workloads.

### EKS Cluster Configuration

```hcl
resource "aws_eks_cluster" "main" {
  name    = "shopmesh-prod"
  version = "1.30"
  role_arn = aws_iam_role.cluster.arn    # IAM role for the control plane

  vpc_config {
    subnet_ids = [
      # Both public AND private subnets — control plane ENIs go in private
      # but need both for cross-AZ communication
      private_subnet_1a, private_subnet_1b,
      public_subnet_1a,  public_subnet_1b
    ]
    endpoint_public_access  = true   # Allows "kubectl" from engineer's laptop
    endpoint_private_access = true   # Pods can reach API server without going through internet
  }

  # Streams these Kubernetes logs to CloudWatch Logs:
  # /aws/eks/shopmesh-prod/cluster/
  enabled_cluster_log_types = [
    "api",               # API server requests (who called what)
    "audit",             # Security audit trail
    "authenticator",     # IRSA token validation logs
    "controllerManager", # Deployment rollout decisions
    "scheduler"          # Pod scheduling decisions
  ]
}
```

**Why enable both public and private endpoint?**
- Public: so engineers can run `kubectl get pods` from their laptops
- Private: so pods inside the cluster reach the API server over the internal network (faster, more secure, no internet dependency)

### Managed Node Group — The Worker Machines

```hcl
resource "aws_eks_node_group" "main" {
  cluster_name    = "shopmesh-prod"
  node_group_name = "shopmesh-prod-nodes"
  node_role_arn   = aws_iam_role.node.arn

  subnet_ids     = [private_subnet_1a, private_subnet_1b]  # Nodes in private subnets

  instance_types = ["t3.medium"]   # 2 vCPU, 4GB RAM per node
  disk_size      = 50              # 50GB EBS gp3 root volume (stores container images)

  scaling_config {
    min_size     = 2    # Never fewer than 2 (high availability — one per AZ)
    desired_size = 4    # Normal operating state
    max_size     = 6    # Cluster Autoscaler can scale up to this
  }
}
```

**Why t3.medium?** Capstone project — balances cost and capacity. Production workloads would use c5.xlarge or larger.

**Why min=2?** Kubernetes distributes pods across nodes. If there's only 1 node and it has a hardware failure, all pods go down. With 2 nodes across 2 AZs, one AZ can fail and the other keeps serving traffic.

### Pod Limits Per Node (Important — Caused Issues)

EKS assigns a real VPC IP address to every pod (unlike other Kubernetes setups). This means pod count is limited by how many IPs the node can hold, which is limited by its network interface capacity:

```
t3.medium ENI capacity:
  3 network interfaces (ENIs) × 6 IP addresses per ENI = 18 IPs
  Minus 1 per ENI for the ENI itself = 15
  Plus 2 (host networking pods) = 17 pods maximum

With 4 nodes: 4 × 17 = 68 total pod slots in the cluster
```

This limitation caused a real problem during the project: when 3 nodes were running, some pods went into `Pending` state because there were no IP addresses left. The fix was changing `desired_size` from 3 to 4.

### EKS Managed Add-ons

Add-ons are extra Kubernetes components that EKS manages for you (automatic security updates, version compatibility):

| Add-on | What It Does | Why It's Needed |
|--------|-------------|-----------------|
| `vpc-cni` | Assigns VPC IP addresses to pods | Every pod needs a real IP for EKS networking |
| `coredns` | Answers DNS queries inside the cluster | Pods find each other by name (e.g., `auth-service.production.svc.cluster.local`) |
| `kube-proxy` | Writes iptables rules on each node | Makes Kubernetes Service IPs work (ClusterIP) |
| `aws-ebs-csi-driver` | Creates EBS volumes for PersistentVolumeClaims | Prometheus and Grafana need persistent storage |
| `amazon-cloudwatch-observability` | Container Insights metrics + log collection | CPU/memory per pod visible in CloudWatch |

### OIDC Provider — Foundation for IRSA

After the cluster is created, Terraform creates one more critical resource:

```hcl
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  # e.g.: https://oidc.eks.us-east-1.amazonaws.com/id/31C1A55C8897593EEDE37B3C29827E3D
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
}
```

This registers EKS as a trusted **identity provider** in IAM. It tells AWS: "When a pod presents a JWT token signed by this EKS cluster's OIDC endpoint, trust it and allow it to assume the IAM role it requests." This is the bridge that makes IRSA possible.

---

## 7. IRSA — How Pods Get AWS Permissions

### The Problem IRSA Solves

Before IRSA, the common (bad) approach was:
```
# In pod environment:
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

Problems with this:
- The key never expires — if it leaks (in logs, in a git commit, in an error message), it's valid forever until manually rotated
- If you rotate it, every pod using it breaks until it's updated
- Every service uses the same key — one leak compromises everything
- Keys stored in ConfigMaps or Secrets can be read by any pod in the cluster

**IRSA (IAM Roles for Service Accounts)** eliminates all of these problems by using temporary credentials that automatically rotate every 15 minutes, with no key to store anywhere.

### How IRSA Works — Full Step-by-Step

```
┌─────────────────────────────────────────────────────────┐
│ SETUP (done once by Terraform)                           │
│                                                          │
│ 1. Create IAM Role with OIDC Trust Policy:               │
│    "Allow the auth-service ServiceAccount in the         │
│     production namespace to assume this role"            │
│                                                          │
│ 2. Attach IAM Policy to role:                            │
│    "Allow DynamoDB GetItem/PutItem on shopmesh-users"    │
│    "Allow SecretsManager GetSecretValue on jwt-secret"   │
└─────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────┐
│ HELM CHART DEPLOYMENT (done by ArgoCD)                   │
│                                                          │
│ ServiceAccount:                                          │
│   name: auth-service                                     │
│   namespace: production                                  │
│   annotations:                                           │
│     eks.amazonaws.com/role-arn: "arn:aws:iam::...role"  │
└─────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────┐
│ POD CREATION (EKS mutating admission webhook)            │
│                                                          │
│ When auth-service pod starts, EKS automatically:         │
│                                                          │
│ 1. Injects environment variables:                        │
│    AWS_ROLE_ARN=arn:aws:iam::242969680553:role/...       │
│    AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/...      │
│                                                          │
│ 2. Mounts a Kubernetes "projected volume" at:            │
│    /var/run/secrets/eks.amazonaws.com/serviceaccount/    │
│    token                                                 │
│    (This is a signed JWT from EKS's OIDC endpoint,       │
│     valid for 24 hours, auto-refreshed)                  │
└─────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────┐
│ RUNTIME (every time code calls an AWS service)           │
│                                                          │
│ 1. AWS SDK reads AWS_WEB_IDENTITY_TOKEN_FILE env var     │
│ 2. Reads the JWT from that file path                     │
│ 3. Calls STS: AssumeRoleWithWebIdentity                  │
│    - Sends the JWT as proof of identity                  │
│    - Sends the role ARN to assume                        │
│ 4. STS validates:                                        │
│    - Is this JWT signed by the trusted OIDC provider?    │
│    - Does the JWT say "sub=system:serviceaccount:        │
│      production:auth-service"?                           │
│    - Does the IAM role allow that ServiceAccount?        │
│ 5. STS returns temporary credentials (valid 15 min)      │
│ 6. SDK uses those creds for the DynamoDB call            │
│ 7. Credentials are cached and auto-refreshed             │
└─────────────────────────────────────────────────────────┘
```

### All 11 IRSA Roles

Each role is tightly scoped — no role has more permissions than its service needs:

**1. `shopmesh-irsa-auth-service`**
- Namespace/SA: `production/auth-service`
- DynamoDB: GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan on `shopmesh-users` table only
- Secrets Manager: GetSecretValue on `shopmesh/jwt-secret` only
- Why: Auth service manages user accounts and issues JWTs. It needs to read/write users and get the signing key.

**2. `shopmesh-irsa-product-service`**
- Namespace/SA: `production/product-service`
- DynamoDB: CRUD on `shopmesh-products` table only
- S3: GetObject, PutObject, DeleteObject on `shopmesh-product-images-242969680553` bucket only
- SNS: Publish to `shopmesh-orders` topic
- Why: Product service manages catalog and images. Publishes SNS events when products change.

**3. `shopmesh-irsa-order-service`**
- Namespace/SA: `production/order-service`
- DynamoDB: CRUD on `shopmesh-orders` table only
- SQS: SendMessage, ReceiveMessage, DeleteMessage on `shopmesh-order-processing` queue
- SNS: Publish to both `shopmesh-orders` and `shopmesh-alerts` topics
- Why: Order service creates orders and puts them in the queue for async processing.

**4. `shopmesh-irsa-analytics-service`**
- Namespace/SA: `production/analytics-service`
- DynamoDB: GetItem, Query, Scan (read-only) on `shopmesh-orders` and `shopmesh-products`
- CloudWatch: PutMetricData (to publish custom business metrics)
- Why: Analytics only reads data — write access would be a security risk.

**5. `shopmesh-irsa-ai-assistant-service`**
- Namespace/SA: `production/ai-assistant-service`
- STS: AssumeRole on `arn:aws:iam::686591366739:role/shopmesh-bedrock-cross-account`
- Why: Bedrock is in a different AWS account (686591366739). This service assumes a cross-account role to call Bedrock.

**6. `shopmesh-irsa-external-secrets`**
- Namespace/SA: `external-secrets/external-secrets-sa`
- Secrets Manager: DescribeSecret, GetSecretValue, ListSecrets (for all `shopmesh/*` secrets)
- Why: External Secrets Operator is the only thing allowed to read secrets from AWS — it distributes them to pods as Kubernetes Secrets.

**7. `shopmesh-irsa-aws-lb-controller`**
- Namespace/SA: `kube-system/aws-load-balancer-controller`
- Full ALB/NLB management: CreateLoadBalancer, CreateTargetGroup, RegisterTargets, CreateRule, etc.
- Why: The controller needs to create and update AWS load balancing resources on behalf of Kubernetes.

**8. `shopmesh-irsa-cloudwatch-agent`**
- Namespace/SA: `amazon-cloudwatch/cloudwatch-agent`
- CloudWatch: PutMetricData, CreateLogGroup, CreateLogStream, PutLogEvents
- Why: Container Insights agent collects pod metrics and streams them to CloudWatch.

**9. `shopmesh-irsa-fluent-bit`**
- Namespace/SA: `amazon-cloudwatch/fluent-bit`
- CloudWatch Logs: CreateLogGroup, CreateLogStream, PutLogEvents, DescribeLogStreams
- Why: Fluent Bit ships application logs from pods to CloudWatch.

**10. `shopmesh-irsa-ebs-csi`**
- Namespace/SA: `kube-system/ebs-csi-controller-sa`
- EC2: CreateVolume, AttachVolume, DetachVolume, DeleteVolume, CreateSnapshot, DescribeVolumes
- Why: When Prometheus or Grafana requests a PersistentVolume, the EBS CSI driver creates an EBS disk.

**11. `shopmesh-irsa-grafana`**
- Namespace/SA: `monitoring/monitoring-grafana`
- CloudWatch: GetMetricData, ListMetrics, GetMetricStatistics, GetMetricStream
- CloudWatch Logs: DescribeLogGroups, GetLogEvents, StartQuery, GetQueryResults
- Why: Grafana's CloudWatch datasource uses this role to query AWS metrics and logs for dashboards.

### IRSA Trust Policy — The Exact JSON

This is the IAM policy that says "who is allowed to assume this role":

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::242969680553:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/31C1A55C8897593EEDE37B3C29827E3D"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.us-east-1.amazonaws.com/id/31C1A55C8897593EEDE37B3C29827E3D:sub":
          "system:serviceaccount:production:auth-service",
        "oidc.eks.us-east-1.amazonaws.com/id/31C1A55C8897593EEDE37B3C29827E3D:aud":
          "sts.amazonaws.com"
      }
    }
  }]
}
```

Reading this: "Allow the OIDC provider (EKS cluster) to grant `sts:AssumeRoleWithWebIdentity`, but ONLY when the token's subject (`sub`) is exactly `system:serviceaccount:production:auth-service`". This means the `auth-service` ServiceAccount in the `production` namespace can assume this role — but `order-service` in the same namespace cannot, and `auth-service` in a different namespace cannot.

---

## 8. Helm — Packaging Kubernetes Applications

### What Is Helm and Why Use It?

Without Helm, deploying an application to Kubernetes means writing many separate YAML files:
- `deployment.yaml` — the pod spec
- `service.yaml` — the network endpoint
- `configmap.yaml` — the environment variables
- `serviceaccount.yaml` — the IAM identity
- `hpa.yaml` — the autoscaling rules
- And more...

Every service needs all of these. Without Helm, you'd have 6 services × 8 files = 48 YAML files that are 90% identical, differing only in `name`, `port`, and `image`. Maintaining 48 near-duplicate files is a maintenance nightmare.

**Helm** is a package manager for Kubernetes. You write templates once with variables (`{{ .Values.service.port }}`), then provide a `values.yaml` file with the actual values per service. One template set, 6 different values files = 6 deployments.

### Chart Structure (Same for All 6 Services)

```
charts/auth-service/
├── Chart.yaml           ← Chart metadata
│     name: auth-service
│     version: 1.0.0
│     description: Authentication microservice
│
├── values.yaml          ← Default values (also what ArgoCD uses for prod)
│
└── templates/
    ├── deployment.yaml      ← Pod specification (containers, resources, probes)
    ├── service.yaml         ← ClusterIP Service (stable DNS for other pods)
    ├── configmap.yaml       ← Non-secret env vars (PORT, DYNAMODB table name, etc.)
    ├── serviceaccount.yaml  ← ServiceAccount with IRSA role annotation
    ├── hpa.yaml             ← HorizontalPodAutoscaler (auto-scale 2→6 replicas)
    ├── networkpolicy.yaml   ← Allow only VPC traffic (10.0.0.0/16)
    └── externalsecret.yaml  ← Pull JWT_SECRET from AWS Secrets Manager
```

### Real `values.yaml` — auth-service

```yaml
namespace: production
replicaCount: 2            # Always 2 pods minimum for HA

image:
  repository: 242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/auth-service
  tag: 40ddaf5             # Git commit SHA — updated automatically by CI
  pullPolicy: Always       # Always pull (never use cached image from node)

service:
  port: 3001               # ClusterIP port (used in Kubernetes DNS calls)

serviceAccount:
  create: true
  roleArn: "arn:aws:iam::242969680553:role/shopmesh-irsa-auth-service"

config:                    # These become ConfigMap keys → pod environment variables
  PORT: "3001"
  NODE_ENV: "production"
  LOCAL_MODE: "false"
  AWS_REGION: "us-east-1"
  DYNAMODB_USERS_TABLE: "shopmesh-users"
  JWT_EXPIRES_IN: "24h"

externalSecret:
  enabled: true            # Create ExternalSecret CRD to pull JWT_SECRET
  refreshInterval: "1h"
  secretStoreName: "aws-secrets-manager"
  secretStoreKind: "ClusterSecretStore"
  remoteSecretName: "shopmesh/jwt-secret"
  secretKeys:
    - secretKey: JWT_SECRET
      remoteKey: "shopmesh/jwt-secret"
      property: "jwt_secret"

resources:
  requests:
    cpu: "100m"            # 0.1 CPU cores minimum guaranteed
    memory: "128Mi"        # 128MB RAM minimum guaranteed
  limits:
    cpu: "500m"            # 0.5 CPU cores maximum allowed
    memory: "512Mi"        # 512MB RAM maximum (OOMKilled if exceeded)

hpa:
  minReplicas: 2
  maxReplicas: 6
  cpuTargetUtilization: 60    # Scale up if avg CPU > 60%
  memoryTargetUtilization: 75 # Scale up if avg memory > 75%

livenessProbe:             # Restart container if it fails this check
  initialDelaySeconds: 30  # Wait 30s for app to start before checking
  periodSeconds: 10        # Check every 10 seconds
  timeoutSeconds: 5        # Fail if response takes > 5s
  failureThreshold: 3      # Restart after 3 consecutive failures

readinessProbe:            # Remove from load balancer if it fails this
  initialDelaySeconds: 15
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3

networkPolicy:
  enabled: true            # Restrict inbound to VPC CIDR only
```

### How Helm Renders a Template (Step by Step)

When ArgoCD deploys `auth-service`, Helm internally runs:
```bash
helm template auth-service charts/auth-service \
  --values charts/auth-service/values.yaml \
  --values environments/prod/values/auth-service.yaml \
  --namespace production
```

**Template engine reads each file in `templates/` and replaces placeholders:**

```yaml
# Input: charts/auth-service/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Release.Name }}           # → "auth-service"
  namespace: {{ .Values.namespace }}  # → "production"
  annotations:
    eks.amazonaws.com/role-arn: {{ .Values.serviceAccount.roleArn }}
    # → "arn:aws:iam::242969680553:role/shopmesh-irsa-auth-service"

# Output after rendering:
apiVersion: v1
kind: ServiceAccount
metadata:
  name: auth-service
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::242969680553:role/shopmesh-irsa-auth-service
```

```yaml
# Input: deployment.yaml (simplified)
spec:
  replicas: {{ .Values.replicaCount }}       # → 2
  template:
    spec:
      serviceAccountName: {{ .Release.Name }}  # → "auth-service" (has IRSA annotation above)
      containers:
        - name: auth-service
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          # → "242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/auth-service:40ddaf5"
          envFrom:
            - configMapRef:
                name: {{ .Release.Name }}-config   # → "auth-service-config"
            {{- if .Values.externalSecret.enabled }}
            - secretRef:
                name: {{ .Release.Name }}-secret   # → "auth-service-secret" (from ESO)
            {{- end }}
```

The `{{- if .Values.externalSecret.enabled }}` block: if `enabled: false` in values.yaml, Helm doesn't output those lines at all. This is how one template serves both services that need secrets (auth) and services that don't (frontend).

### Why `pullPolicy: Always`?

By default (`IfNotPresent`), if a node already has the image cached, Kubernetes won't pull a new one. This means if you deploy a new version but use the same tag, the node might run the old cached image. Using `Always` forces a fresh pull every time a pod starts. The image tag is a git SHA (never reused), so this rarely causes unnecessary pulls — but it prevents the catastrophic case of running old code by accident.

---

## 9. ArgoCD — GitOps and Automated Deployments

### What Is GitOps?

Traditional deployment: engineer runs `kubectl apply -f deployment.yaml` → changes applied immediately. Problems:
- No audit trail of who deployed what and when
- Cluster state can drift from what's in git (someone applies a fix manually, forgets to commit)
- No automatic rollback if something goes wrong
- Multiple engineers can accidentally apply conflicting changes

**GitOps** principle: **git is the single source of truth for what should be running**. You never apply directly. You push to git, and a tool (ArgoCD) continuously syncs the cluster to match what git says.

ArgoCD sits inside the cluster and watches the `shopmesh-gitops` repository every 3 minutes (and immediately on webhook). If it finds a difference between what's in git and what's in the cluster, it applies the difference.

### App-of-Apps Pattern — The Bootstrap Hierarchy

ShopMesh uses the "App-of-Apps" pattern, which is a way to manage many ArgoCD Applications from a single root Application. Here's how it works:

```
STEP 1: Engineer applies this ONCE manually (the only manual kubectl apply):
        kubectl apply -f shopmesh-gitops/bootstrap/root-application.yaml

root-application.yaml watches: applications/ directory (recursively)
    │
    ├── applications/infrastructure/
    │   │   (ArgoCD auto-creates one Application for each file here)
    │   │
    │   ├── monitoring-app.yaml         → deploys kube-prometheus-stack (from Helm repo)
    │   ├── monitoring-extras-app.yaml  → deploys charts/monitoring/ (PrometheusRules, TGB)
    │   ├── kgateway-app.yaml           → deploys kgateway (Gateway API implementation)
    │   ├── httproutes-app.yaml         → deploys kgateway HTTPRoutes (routing rules)
    │   ├── aws-lb-controller-app.yaml  → deploys AWS Load Balancer Controller
    │   ├── external-secrets-app.yaml   → deploys External Secrets Operator + ClusterSecretStore
    │   ├── fluent-bit-app.yaml         → deploys Fluent Bit log forwarder
    │   └── metrics-server-app.yaml     → deploys metrics-server (required for HPA)
    │
    └── applications/services/
            (Each file below causes ArgoCD to watch its chart and keep it deployed)
        ├── frontend-app.yaml           → charts/frontend/
        ├── auth-service-app.yaml       → charts/auth-service/
        ├── product-service-app.yaml    → charts/product-service/
        ├── order-service-app.yaml      → charts/order-service/
        ├── analytics-service-app.yaml  → charts/analytics-service/
        └── ai-assistant-service-app.yaml → charts/ai-assistant-service/
```

**The key insight**: Once the root Application is applied, it creates all the other Applications. Those Applications watch the charts and deploy everything. The entire platform self-bootstraps from one `kubectl apply`.

### Root Application — Exact YAML

```yaml
# bootstrap/root-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shopmesh-root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io   # Delete child apps when this is deleted
spec:
  project: default
  source:
    repoURL: https://github.com/shopmesh-final/shopmesh-gitops.git
    targetRevision: HEAD      # Always latest commit on main branch
    path: applications        # Watches this directory recursively
    directory:
      recurse: true           # Includes subdirectories (infrastructure/ and services/)
  destination:
    server: https://kubernetes.default.svc   # This cluster
    namespace: argocd
  syncPolicy:
    automated:
      prune: true      # If you delete a file from applications/, delete the ArgoCD App too
      selfHeal: true   # If someone manually deletes an ArgoCD App, re-create it
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

### Service Application — Exact YAML (auth-service)

```yaml
# applications/services/auth-service-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: auth-service
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/shopmesh-final/shopmesh-gitops.git
    targetRevision: HEAD
    path: charts/auth-service   # Helm chart directory
    helm:
      valueFiles:
        - values.yaml
        - ../../environments/prod/values/auth-service.yaml  # Prod overrides
  destination:
    server: https://kubernetes.default.svc
    namespace: production      # Deploy into the "production" namespace
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
  ignoreDifferences:
    # ESO adds fields to ExternalSecret that aren't in our template — ignore them
    - group: external-secrets.io
      kind: ExternalSecret
      jqPathExpressions:
        - .spec.data[].remoteRef.conversionStrategy
        - .spec.data[].remoteRef.decodingStrategy
        - .spec.data[].remoteRef.metadataPolicy
```

### The ArgoCD Sync Cycle (What Happens Every 3 Minutes)

```
1. argocd-repo-server contacts GitHub API
   → Checks if shopmesh-gitops HEAD commit hash changed
   
2. If changed (or 3 minutes elapsed):
   → Git clone/fetch the repo
   → Run: helm template auth-service charts/auth-service --values ...
   → Produces Kubernetes YAML (Deployment, Service, ConfigMap, etc.)
   
3. Compare rendered YAML with live cluster objects:
   → kubectl get deployment auth-service -n production -o yaml
   → Diff: is .spec.template.spec.containers[0].image the same?
   
4. If diff found:
   → Since automated.selfHeal=true: apply the diff immediately
   → ArgoCD uses server-side apply (kubectl apply --server-side)
   → The diff is applied in seconds
   
5. Kubernetes rolling update:
   → Creates 1 new pod with new image
   → Waits for it to pass readinessProbe
   → Terminates 1 old pod
   → Repeats until all pods are updated
   → Zero downtime if readiness probe works
```

### Why `selfHeal: true` Matters

Without selfHeal, if an engineer runs `kubectl edit deployment auth-service` and changes the image, that change would persist. With selfHeal=true, ArgoCD detects the drift within 3 minutes and reverts it to match git. This enforces that **git is always the truth** — no sneaky manual changes persist.

### Infrastructure App — External Helm Repository

Not all ArgoCD apps point to the gitops repo. Infrastructure tools come from public Helm repositories:

```yaml
# monitoring-app.yaml
source:
  repoURL: https://prometheus-community.github.io/helm-charts  # External chart repo
  chart: kube-prometheus-stack
  targetRevision: "65.1.1"   # Pin exact chart version — no surprise upgrades
  helm:
    values: |
      # Inline values override — same as a values.yaml but embedded in the Application
      fullnameOverride: monitoring
      grafana:
        ...
```

For the AWS Load Balancer Controller:
```yaml
# aws-lb-controller-app.yaml
source:
  repoURL: https://aws.github.io/eks-charts
  chart: aws-load-balancer-controller
  targetRevision: 3.4.0
  helm:
    values: |
      clusterName: shopmesh-prod
      serviceAccount:
        annotations:
          eks.amazonaws.com/role-arn: "arn:aws:iam::242969680553:role/shopmesh-irsa-aws-lb-controller"
      region: us-east-1
```

---

## 10. CI/CD Pipeline — From Code to Running Pod

### The Full Delivery Pipeline

```
Developer writes code on laptop
      ↓
git push to feature branch
      ↓
Open Pull Request on GitHub
      ↓ (GitHub Actions triggers automatically)
┌─────────────────────────────────┐
│  PR CHECKS (blocks merge)       │
│  1. Docker build (fails fast)   │
│  2. Trivy security scan         │
│  3. Helm lint                   │
│  Result posted to PR as checks  │
└─────────────────────────────────┘
      ↓ (engineer reviews, approves)
Merge PR to main
      ↓ (GitHub Actions triggers)
┌─────────────────────────────────────────────────────────────┐
│  MAIN BRANCH PIPELINE                                        │
│                                                             │
│  Step 1: Checkout code                                      │
│  Step 2: GitHub OIDC → AWS temporary credentials            │
│  Step 3: ECR login (no password — uses OIDC creds)          │
│  Step 4: Trivy scan on image BEFORE push                    │
│  Step 5: docker build -t ...ecr.../auth-service:${SHA} .    │
│  Step 6: docker push to ECR                                 │
│  Step 7: Update shopmesh-gitops values.yaml (new image tag) │
│  Step 8: git push to shopmesh-gitops                        │
└─────────────────────────────────────────────────────────────┘
      ↓ (ArgoCD polls gitops repo every 3 min)
ArgoCD detects new image tag in values.yaml
      ↓
ArgoCD renders Helm template with new tag
      ↓
ArgoCD applies Deployment with new image
      ↓
Kubernetes rolling update (zero downtime)
      ↓
New pod running → old pod terminated
```

### GitHub OIDC — Why There Are No AWS Keys in GitHub

Traditionally, CI/CD pipelines stored AWS keys as GitHub Secrets:
```
# BAD — what we do NOT do
AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG...
```

These keys never expire, have to be rotated manually, and if GitHub is breached or a repo is accidentally made public, the keys are exposed.

**GitHub OIDC** (OpenID Connect) works like IRSA for pods — GitHub can generate a short-lived JWT token that proves "this workflow is running in repo X on branch Y". AWS is configured to trust this JWT and exchange it for temporary credentials.

**Terraform configuration (github-oidc.tf):**
```hcl
# Register GitHub as a trusted OIDC provider in AWS IAM
resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# Role that GitHub Actions CI can assume (for ECR push)
resource "aws_iam_role" "github_actions" {
  assume_role_policy = jsonencode({
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Condition = {
        StringLike = {
          "token.actions.githubusercontent.com:sub" =
            "repo:shopmesh-final/shopmesh-app:*"   # Only THIS repo
        }
      }
    }]
  })
}

# Role that Terraform CI can assume (for infrastructure changes)
resource "aws_iam_role" "terraform_ci" {
  # Same OIDC trust but for shopmesh-terraform repo
  # Has AdministratorAccess policy attached
}
```

**In the GitHub Actions workflow:**
```yaml
- name: Configure AWS Credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::242969680553:role/shopmesh-github-actions-ecr
    aws-region: us-east-1
    # No access key, no secret key! GitHub presents its OIDC token automatically.
```

### Trivy Security Scanning — Why and What It Does

Trivy scans the Docker image for known CVEs (Common Vulnerabilities and Exposures) — security vulnerabilities in OS packages and application dependencies. Without this, you might unknowingly ship an image with a critical vulnerability (e.g., a Node.js version with a known remote code execution bug).

```bash
trivy image \
  --exit-code 1 \                       # Exit with code 1 (failure) if found
  --severity HIGH,CRITICAL \            # Only fail on high and critical CVEs
  --format table \
  242969680553.dkr.ecr.us-east-1.amazonaws.com/shopmesh/auth-service:${SHA}
```

- If no HIGH/CRITICAL vulnerabilities → continues to next step
- If vulnerabilities found → pipeline fails, PR merge is blocked, engineers are notified via GitHub PR check status

### The GitOps Update Step — How the Deploy Actually Happens

After pushing the image to ECR, the pipeline updates the GitOps repo:

```bash
# In the CI workflow:
git clone https://github.com/shopmesh-final/shopmesh-gitops.git
cd shopmesh-gitops

# Update the image tag in values.yaml:
sed -i "s/tag: .*/tag: ${GITHUB_SHA::7}/" charts/auth-service/values.yaml
# e.g., changes:  tag: 40ddaf5
#             to: tag: 7f3a9c1

git config user.email "ci@shopmesh.shop"
git config user.name "ShopMesh CI"
git add charts/auth-service/values.yaml
git commit -m "ci: update auth-service image to ${GITHUB_SHA::7}"
git push origin main
```

This is the key moment. The image tag in `values.yaml` is now different. ArgoCD detects this within 3 minutes, re-renders the Helm template with the new tag, and applies the Deployment. Kubernetes starts a rolling update — new pods with the new image are created, health-checked, then old pods are terminated.

### Terraform CI Pipeline

Infrastructure changes go through their own pipeline in `shopmesh-terraform`:

```
Push to feature branch:
  → terraform fmt (check formatting)
  → terraform validate (syntax check)
  → terraform plan (show what would change — posted as PR comment)

Merge to main:
  → terraform init (download providers, sync state)
  → terraform validate
  → terraform plan
  → Manual approval gate (engineer reviews plan output)
  → terraform apply (makes real changes to AWS)
```

---

## 11. Microservices — What They Do and How They Talk

### Service Overview

| Service | Port | Technology | Role |
|---------|------|-----------|------|
| `frontend` | 80 | React 18 + React Router v6 + Axios · served by nginx | Serves the web UI, proxies API calls internally |
| `auth-service` | 3001 | Node.js · Express 4 · jsonwebtoken · bcryptjs | User registration, login, JWT token issuance |
| `product-service` | 3002 | Node.js · Express 4 · AWS SDK v3 · s3-request-presigner | Product catalog CRUD, image management |
| `order-service` | 3003 | **Python · FastAPI · Pydantic** (saga pattern with rollback) | Order creation, stock management, async processing |
| `analytics-service` | 3004 | **Python · FastAPI · boto3** | Aggregated order + product + user analytics |
| `ai-assistant-service` | 3005 | **Python · FastAPI · Pydantic** · Bedrock Converse API | AI shopping assistant with cart_actions support |

Each service is completely independent:
- Separate codebase (directory in shopmesh-app)
- Separate Docker image in ECR
- Separate deployment in Kubernetes
- Separate IRSA role with only its own permissions
- Separate DynamoDB table (no shared database)

**Why microservices instead of one big app?**
- Scale independently: if order-service gets heavy load on Black Friday, scale it to 6 replicas without scaling everything else
- Deploy independently: update auth-service without touching product-service
- Failure isolation: if analytics-service crashes, users can still place orders
- Team independence: different engineers can own different services

### Frontend — React SPA Served by nginx

The frontend is a **Single-Page Application (SPA)**. The browser downloads the React app once, and then subsequent navigation happens entirely in the browser (React Router). When the user clicks "Products", the browser doesn't load a new page from the server — React just renders the products component.

**The Docker image build:**
1. Node.js builds the React app: `npm run build` → produces static files (HTML, CSS, JS bundles)
2. These static files are copied into an nginx container
3. nginx serves them to browsers

**nginx.conf — Two Responsibilities:**

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    # ── Responsibility 1: Proxy API calls to backend ──────────────────
    # INTERNAL_ALB_URL is set by envsubst when the container starts
    # Value: http://prod.kgateway-system.svc.cluster.local:80
    # (Kubernetes DNS name for the kgateway Envoy proxy)
    
    location /api/auth {
        proxy_pass ${INTERNAL_ALB_URL}/api/auth;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
    location /api/products { proxy_pass ${INTERNAL_ALB_URL}/api/products; ... }
    location /api/orders   { proxy_pass ${INTERNAL_ALB_URL}/api/orders;   ... }
    location /api/analytics{ proxy_pass ${INTERNAL_ALB_URL}/api/analytics; proxy_read_timeout 60s; }
    location /api/assistant{ proxy_pass ${INTERNAL_ALB_URL}/api/assistant; proxy_read_timeout 90s; }
    # (assistant has 90s timeout — Bedrock AI can be slow)

    # ── Responsibility 2: Serve React SPA ─────────────────────────────
    location / {
        try_files $uri $uri/ /index.html;
        # If user navigates to /products/123 directly (refresh or link share),
        # nginx tries: /products/123 (doesn't exist as file) → /index.html
        # React then reads the URL and renders the right component
    }
    
    # ── Static asset caching ──────────────────────────────────────────
    location ~* \.(js|css|png|jpg|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        # These files have hashed names (main.abc123.js), safe to cache forever
    }
    
    # ── Health check for ALB ──────────────────────────────────────────
    location /health {
        return 200 '{"status":"OK","service":"frontend"}';
        add_header Content-Type application/json;
    }
}
```

**Why does nginx proxy to kgateway instead of directly to auth-service?**
Because the frontend doesn't know which port each service runs on, and those could change. kgateway is a stable internal API gateway — the frontend sends all API calls to one place, and kgateway routes them.

### Complete End-to-End Request Trace — User Places an Order

Let's trace every network hop when a logged-in user clicks "Place Order":

```
1. BROWSER
   POST https://shopmesh.shop/api/orders
   Headers: Authorization: Bearer <JWT>
   Body: { "productId": "p123", "quantity": 2 }

2. DNS RESOLUTION
   shopmesh.shop → CNAME → d3sd0da2hnk8ea.cloudfront.net
   → Resolves to nearest CloudFront edge IP

3. CLOUDFRONT EDGE (e.g., in New York)
   - Receives HTTPS request
   - Checks path: /api/orders matches behavior "/api/*"
   - Behavior: forward all cookies + headers, no caching
   - Forwards over HTTP to origin: shopmesh-external-alb.us-east-1.elb.amazonaws.com:80

4. ALB (Application Load Balancer — us-east-1)
   - Receives HTTP request
   - Evaluates listener rules for port 80:
     * Rule 100: does path match /grafana or /grafana/*? NO
     * Default: forward to shopmesh-frontend-tg
   - Picks a healthy frontend pod IP from the target group
   - Forwards request to: 10.0.11.x:80 (frontend pod)

5. FRONTEND POD (nginx)
   - Receives HTTP request for /api/orders
   - Matches `location /api/orders`
   - proxy_pass to: http://prod.kgateway-system.svc.cluster.local:80/api/orders
   - Kubernetes DNS resolves "prod.kgateway-system.svc.cluster.local"
     → ClusterIP: 172.20.x.x (virtual IP inside the cluster)
     → kube-proxy routes this to kgateway pod: 10.0.10.y:8080

6. KGATEWAY (Envoy proxy)
   - Receives request
   - Reads HTTPRoute "order-route" — PathPrefix: /api/orders
   - Backend: order-service.production.svc.cluster.local:3003
   - DNS resolves → kube-proxy routes → order-service pod: 10.0.11.z:3003

7. ORDER-SERVICE POD
   a. Validates JWT:
      - Calls auth-service internally:
        GET http://auth-service.production.svc.cluster.local:3001/api/auth/verify
        Headers: Authorization: Bearer <JWT>
      - auth-service verifies JWT signature using JWT_SECRET (from Kubernetes Secret, originally from Secrets Manager)
      - Returns: { userId: "u456", valid: true }
   
   b. Writes to DynamoDB (using IRSA credentials, no stored keys):
      - Table: shopmesh-orders
      - Item: { orderId, userId, productId, quantity, status: "pending", timestamp }
   
   c. Sends message to SQS:
      - Queue: https://sqs.us-east-1.amazonaws.com/242969680553/shopmesh-order-processing
      - Message: { orderId, userId, productId, quantity }
      - SQS persists message until a consumer processes it
   
   d. Publishes to SNS:
      - Topic: arn:aws:sns:us-east-1:242969680553:shopmesh-orders
      - Message: { event: "ORDER_CREATED", orderId, amount }
      - SNS fans out to subscribers (analytics listener, EventBridge rule)

8. SNS → EVENTBRIDGE
   - EventBridge rule checks: is order amount > $100?
   - If yes → publish alert to shopmesh-alerts SNS topic
   - (In production: alerts SNS → email subscription → engineers notified)

9. RESPONSE TRAVELS BACK
   order-service → 201 { orderId: "o789", status: "confirmed" }
   → kgateway → frontend nginx → ALB → CloudFront → browser
   
   Total time: ~200-400ms (DynamoDB + SQS calls are fast)
```

### Auth Service — JWT Authentication Flow

**Registration:**
```
POST /api/auth/register
  { email, password }
  ↓
auth-service hashes password (bcrypt, salt rounds 10)
  ↓
PutItem to DynamoDB shopmesh-users:
  { userId: uuid, email, passwordHash, createdAt }
  ↓
Returns: { userId, email }
```

**Login:**
```
POST /api/auth/login
  { email, password }
  ↓
Query DynamoDB shopmesh-users by email
  ↓
bcrypt.compare(inputPassword, storedHash)
  ↓
If match: sign JWT with JWT_SECRET (from Kubernetes Secret)
  JWT payload: { userId, email, exp: now + 24h }
  ↓
Returns: { token: "eyJhbGci..." }
```

**Token Verification (called by other services):**
```
GET /api/auth/verify
  Headers: Authorization: Bearer <token>
  ↓
jwt.verify(token, JWT_SECRET)
  ↓
If valid: { userId, email, valid: true }
If expired or tampered: 401 Unauthorized
```

### AI Assistant — Cross-Account Bedrock Call

```
POST /api/assistant
  { message: "What running shoes do you have under $100?" }
  ↓
ai-assistant-service (IRSA role: shopmesh-irsa-ai-assistant-service)
  ↓
STS AssumeRole call:
  Role: arn:aws:iam::686591366739:role/shopmesh-bedrock-cross-account
  Returns: temporary credentials for account 686591366739
  ↓
Bedrock Converse API (using cross-account credentials):
  Model: amazon.nova-lite-v1:0
  System prompt: "You are ShopMesh's AI shopping assistant..."
  User message: "What running shoes do you have under $100?"
  + Context: [list of products from product-service]
  ↓
Bedrock returns: "We have the following running shoes under $100:
  1. Nike Air Zoom ($89.99)..."
  ↓
Response sent back to user
```

**Why cross-account?** Bedrock was enabled on a separate AWS account (686591366739) during setup. The AI service assumes a role in that account to use Bedrock. This is a common pattern in large organizations where different teams manage different accounts.

### Service-to-Service Communication — Kubernetes DNS

Every Kubernetes Service gets a stable DNS name:
```
<service-name>.<namespace>.svc.cluster.local:<port>
```

Examples:
- `auth-service.production.svc.cluster.local:3001`
- `product-service.production.svc.cluster.local:3002`
- `monitoring-grafana.monitoring.svc.cluster.local:80`

When order-service calls auth-service, it uses the full DNS name. CoreDNS (the cluster DNS server) resolves this to the Service's ClusterIP. kube-proxy (running on every node) has iptables rules that intercept traffic to that ClusterIP and load-balance it to the actual pod IPs. The calling service doesn't need to know pod IPs — they change constantly as pods restart.

### HPA — Horizontal Pod Autoscaling

All services have an HPA that scales replicas based on CPU and memory:

```
metrics-server (installed in kube-system) collects CPU/memory per pod every 15s
  ↓
HPA controller compares current usage to target:
  auth-service HPA: target CPU=60%, target memory=75%
  
  Current: 2 pods, avg CPU=80% (above 60% target)
  Calculation: desired_replicas = ceil(current_replicas * current_cpu / target_cpu)
             = ceil(2 * 80 / 60) = ceil(2.67) = 3
  
  Action: scale from 2 to 3 replicas
  ↓
Kubernetes creates 1 new pod
  ↓
Pod scheduled on a node with available capacity
  ↓
After 3-5 minutes, average CPU drops to 50%:
  desired_replicas = ceil(3 * 50 / 60) = ceil(2.5) = 3 (no change yet)
  After stabilization period (5 min): scale back to 2
```

---

## 12. kgateway — Internal Service Router

### What Is kgateway and Why Use It?

Without kgateway, to route `/api/auth` calls to auth-service, you'd need either:
1. Direct pod IPs hardcoded in nginx (breaks every time pods restart)
2. Multiple nginx location blocks with direct service names (tight coupling)
3. An AWS ALB for internal routing (expensive, slow, creates unnecessary AWS resources)

**kgateway** is an open-source Kubernetes Gateway API implementation using **Envoy proxy** under the hood. Envoy is a high-performance proxy used by Netflix, Lyft, and AWS internally. kgateway gives you:
- Dynamic routing based on URL path
- Retries and timeout configuration per route
- Traffic splitting for canary deployments
- Protocol-aware routing (HTTP/1.1, HTTP/2, gRPC)

### Gateway Resource

kgateway creates an Envoy proxy pod called `prod` in the `kgateway-system` namespace. This pod has a Kubernetes Service of type `LoadBalancer` (gets a NodePort: 30668) and a ClusterIP.

The internal DNS name `prod.kgateway-system.svc.cluster.local` is what nginx proxies to.

### HTTPRoute Definitions

```yaml
# infrastructure/kgateway/httproutes/auth-route.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: auth-route
  namespace: production
spec:
  parentRefs:
    - name: prod                    # The gateway (Envoy) to attach this route to
      namespace: kgateway-system
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/auth       # Match any request starting with /api/auth
      backendRefs:
        - name: auth-service       # Forward to this Kubernetes Service
          namespace: production
          port: 3001               # On this port
```

The same pattern applies for all services. When ArgoCD deploys `httproutes-app.yaml`, it applies all these route files from `infrastructure/kgateway/httproutes/`.

### Route Matching Priority

Envoy evaluates routes in specificity order — longer prefixes win:
- `/api/auth` (length 9) beats `/api/` (length 5) beats `/` (length 1)
- If a request comes for `/api/products/123`, it matches `/api/products`, not `/api/`

### Why kgateway and Not nginx Ingress or AWS ALB Ingress?

| Option | Issue |
|--------|-------|
| nginx Ingress | Additional component, less traffic management features, doesn't implement Gateway API spec |
| AWS ALB Ingress | Creates a new AWS ALB = ~$20/month + per-request charges, slow to provision (30+ seconds) |
| kgateway | In-cluster, instant routing changes, advanced traffic policies, implements the official Kubernetes Gateway API standard |

---

## 13. AWS Load Balancer Controller and TargetGroupBinding

### What Problem Does This Solve?

The Terraform code creates an ALB and target groups (the list of destinations traffic is forwarded to). But target groups need to know which specific pod IPs to send traffic to. Pod IPs change constantly — every time a pod restarts, it gets a new IP.

**Without ALBC**: You'd have to manually update the target group every time a pod restarts. Impossible at scale.

**With ALBC + TargetGroupBinding**: The controller watches Kubernetes for pod lifecycle events (started, terminated, readiness change) and automatically calls the AWS API to register/deregister pod IPs.

### How TargetGroupBinding Works

**Step 1 — Terraform creates the target group (empty):**
```hcl
resource "aws_lb_target_group" "frontend" {
  name        = "shopmesh-frontend-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"              # ip mode: registers pod IPs directly
  health_check {
    path    = "/health"           # nginx returns 200 for /health
    matcher = "200"
    interval = 30
    timeout  = 5
  }
}
```

**Step 2 — ArgoCD deploys the TargetGroupBinding CRD (from charts/frontend):**
```yaml
# charts/frontend/templates/targetgroupbinding.yaml
{{- if .Values.targetGroupArn }}
apiVersion: elbv2.k8s.aws/v1beta1
kind: TargetGroupBinding
metadata:
  name: frontend-tgb
  namespace: production
spec:
  serviceRef:
    name: frontend      # Watch the Kubernetes Service named "frontend"
    port: 80
  targetGroupARN: {{ .Values.targetGroupArn }}
  # e.g.: arn:aws:elasticloadbalancing:us-east-1:242969680553:targetgroup/shopmesh-frontend-tg/...
  targetType: ip        # Register pod IPs directly into the TG
{{- end }}
```

**Step 3 — ALBC reconciles continuously:**
```
ALBC gets notified: new TargetGroupBinding created
  ↓
ALBC reads the serviceRef: Service "frontend" in "production" namespace
  ↓
ALBC gets the pod IPs from the Service's Endpoints:
  e.g., [10.0.10.45:80, 10.0.11.62:80]
  ↓
ALBC calls: elasticloadbalancing:RegisterTargets
  Targets: [{ Id: "10.0.10.45", Port: 80 }, { Id: "10.0.11.62", Port: 80 }]
  ↓
ALB now forwards traffic directly to pod IPs — no NodePort hop
  ↓
If a pod restarts → new IP → ALBC deregisters old IP, registers new one
If HPA scales to 3 pods → ALBC registers the third pod IP automatically
```

### Grafana Target Group Binding

Grafana is in the `monitoring` namespace and serves on port 3000 (not 80). A separate TGB was created:

```yaml
# charts/monitoring/templates/grafana-tgb.yaml
{{- if .Values.grafanaTGBArn }}
apiVersion: elbv2.k8s.aws/v1beta1
kind: TargetGroupBinding
metadata:
  name: grafana-tgb
  namespace: monitoring    # monitoring namespace, not production
spec:
  serviceRef:
    name: monitoring-grafana    # The Service created by kube-prometheus-stack
    port: 80                    # The Service port (maps to 3000 on the pod)
  targetGroupARN: {{ .Values.grafanaTGBArn }}
  targetType: ip
{{- end }}
```

Values file sets the ARN:
```yaml
# charts/monitoring/values.yaml
grafanaTGBArn: "arn:aws:elasticloadbalancing:us-east-1:242969680553:targetgroup/shopmesh-grafana-tg/98fbc1e2bf85c809"
```

This ARN came from `terraform output grafana_target_group_arn` after the Grafana target group was created by Terraform.

---

## 14. External Secrets Operator — Secrets Without Secrets in Code

### The Problem

Kubernetes Secrets are base64-encoded, not encrypted by default. Anyone with `kubectl get secret -n production auth-service-secret -o yaml` can read the JWT key. Also, how do you get secrets INTO Kubernetes in the first place? If you write them in a YAML file and commit that to git, they're in version history forever.

**External Secrets Operator (ESO)** solves this by:
1. Storing the actual secret in AWS Secrets Manager (encrypted, access-controlled, audited)
2. Running inside the cluster, fetching secrets using IRSA (no stored credentials)
3. Creating Kubernetes Secrets from the fetched values
4. Automatically re-syncing every hour (picks up rotated secrets)

### The ClusterSecretStore

The ClusterSecretStore is the bridge between ESO and AWS Secrets Manager. It's cluster-wide (not per-namespace):

```yaml
# infrastructure/external-secrets/cluster-secret-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa        # The SA with IRSA annotation
            namespace: external-secrets
```

ESO's `external-secrets-sa` ServiceAccount has the IRSA annotation pointing to `shopmesh-irsa-external-secrets` role. When ESO calls `secretsmanager:GetSecretValue`, it uses the IRSA mechanism described earlier — no AWS access key stored anywhere.

### ExternalSecret CRD — Declarative Secret Sync

```yaml
# Rendered by auth-service Helm chart
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: auth-service-secret
  namespace: production
spec:
  refreshInterval: "1h"            # Re-fetch from Secrets Manager every hour
  secretStoreRef:
    name: aws-secrets-manager      # Use the ClusterSecretStore above
    kind: ClusterSecretStore
  target:
    name: auth-service-secret      # Name of the Kubernetes Secret to create/update
    creationPolicy: Owner          # ESO owns this Secret (deletes it when ExternalSecret is deleted)
  data:
    - secretKey: JWT_SECRET        # Key name in the Kubernetes Secret
      remoteRef:
        key: shopmesh/jwt-secret   # Secrets Manager secret name
        property: jwt_secret       # JSON field within the secret value
                                   # (Secrets Manager stores: { "jwt_secret": "actual-value" })
```

**What ESO creates in Kubernetes:**
```yaml
# Kubernetes Secret (auto-created and managed by ESO)
apiVersion: v1
kind: Secret
metadata:
  name: auth-service-secret
  namespace: production
  ownerReferences:   # Points back to the ExternalSecret — deleted together
    - kind: ExternalSecret
      name: auth-service-secret
type: Opaque
data:
  JWT_SECRET: c3VwZXJzZWNyZXR2YWx1ZQ==   # base64 of "supersecretvalue"
```

**How the pod gets it (from Deployment template):**
```yaml
envFrom:
  - configMapRef:
      name: auth-service-config   # Non-secret env vars (PORT, table name, etc.)
  - secretRef:
      name: auth-service-secret   # JWT_SECRET injected as environment variable
```

Inside the auth-service container: `process.env.JWT_SECRET` is available as if it was always there.

### Secret Rotation Flow

```
AWS Secrets Manager: rotate shopmesh/jwt-secret (new value set)
        │
        │  Within 1 hour:
        ▼
ESO reconcile loop detects the secret version changed
        ↓
ESO calls secretsmanager:GetSecretValue with new version
        ↓
ESO updates Kubernetes Secret auth-service-secret with new value
        ↓
PROBLEM: Running pods already have the old JWT_SECRET in memory
        ↓
SOLUTION: kubectl rollout restart deployment/auth-service
New pods start → read new JWT_SECRET from updated Kubernetes Secret
Old pods terminate → all tokens now verified with new key
```

---

## 15. Monitoring — Prometheus and Grafana

### Why This Stack?

**The problem**: with 6 services, 4 nodes, dozens of pods — how do you know when something is wrong? How do you know a pod is using too much memory before it OOMKills? How do you track that 95% of orders succeed?

**Prometheus** collects metrics (numbers over time). **Grafana** visualizes them in dashboards. Together they give you:
- CPU/memory usage per pod in real time
- Application error rates
- Database query latency
- Node disk usage trending toward full
- Automatic alerts when things exceed thresholds

### Stack Components (Deployed as One Helm Release)

`kube-prometheus-stack` v65.1.1 installs all of these together:

```
monitoring namespace:
├── monitoring-prometheus-0 (StatefulSet)
│     • Scrapes metrics from all targets every 30s
│     • Stores time-series data in TSDB (5Gi EBS volume, 7-day retention)
│     • Port: 9090 (internal only)
│
├── monitoring-grafana-* (Deployment)
│     • Web dashboard UI
│     • Reads from Prometheus (local) and CloudWatch (via IRSA)
│     • Port: 3000 (exposed via ALB TGB at /grafana)
│     • 1Gi EBS volume for dashboard storage
│
├── monitoring-alertmanager-0 (StatefulSet)
│     • Receives alerts from Prometheus rule evaluations
│     • Groups, deduplicates, routes alerts
│     • Currently routes all alerts to "null" (capstone — no paging configured)
│
├── monitoring-prometheus-node-exporter (DaemonSet — 1 pod per node)
│     • Runs on EVERY node (DaemonSet ensures this)
│     • Exposes node-level OS metrics on port 9100:
│       node_cpu_seconds_total, node_memory_MemAvailable_bytes, node_disk_io_time_seconds_total
│
├── monitoring-kube-state-metrics-* (Deployment)
│     • Reads Kubernetes API and exports metrics about K8s objects:
│       kube_deployment_status_replicas, kube_pod_status_phase, kube_hpa_status_current_replicas
│
└── monitoring-operator-* (Deployment)
      • Watches ServiceMonitor and PodMonitor CRDs
      • Dynamically updates Prometheus scrape configuration
```

### How Prometheus Discovers What to Scrape

Without Prometheus Operator, you'd manually edit a `prometheus.yml` file to add every scrape target. When pods restart with new IPs, you'd have to update it.

With Prometheus Operator, you create `ServiceMonitor` and `PodMonitor` CRDs:

```yaml
# charts/monitoring/templates/argocd-podmonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: argocd-metrics
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - argocd              # Watch pods in the argocd namespace
  selector:
    matchLabels:
      app.kubernetes.io/name: argocd-server    # Filter to argocd-server pods
  podMetricsEndpoints:
    - port: metrics         # Scrape the port named "metrics" on those pods
      path: /metrics        # GET /metrics endpoint (Prometheus exposition format)
      interval: 30s
```

**The reconciliation loop:**
```
Prometheus Operator watches PodMonitor CRDs
  ↓
When PodMonitor changes (or pod IPs change):
  Operator generates new Prometheus scrape config
  Writes it to a Secret
  Prometheus reloads config via /-/reload endpoint
  ↓
Prometheus now scrapes argocd-server pods on /metrics every 30s
  ↓
Stores metrics like:
  argocd_app_sync_total{app="auth-service",phase="Succeeded"} 47
  argocd_app_health_status{app="auth-service",health_status="Healthy"} 1
```

### kube-prometheus-stack Helm Values (Key Decisions)

```yaml
fullnameOverride: monitoring
# WHY: By default, chart names resources "kube-prometheus-stack-grafana" etc.
# This is ugly and hard to reference. Override makes them "monitoring-grafana" etc.

grafana:
  sidecar:
    datasources:
      enabled: false       # CRITICAL FIX — see "Dual Provisioning Bug" below
    dashboards:
      enabled: true
      searchNamespace: ALL # Watch ALL namespaces for dashboard ConfigMaps
      folderAnnotation: grafana_folder  # Use this annotation to put in the right folder

  grafana.ini:
    server:
      root_url: "https://shopmesh.shop/grafana"  # Full URL with subpath
      serve_from_sub_path: true                  # Serve at /grafana/ not /
  # WHY: Without these, Grafana generates redirect URLs like
  # https://shopmesh.shop/login which don't work — it should be /grafana/login

  persistence:
    enabled: true
    storageClassName: gp2  # EBS gp2 volume for Grafana database
    size: 1Gi

prometheus:
  prometheusSpec:
    retention: 7d          # Delete metrics older than 7 days (cost control)
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp2
          resources:
            requests:
              storage: 5Gi  # 5GB EBS volume for Prometheus TSDB

    # These 3 settings are CRITICAL for picking up external PodMonitors/Rules:
    podMonitorSelectorNilUsesHelmValues: false     # Don't restrict to this namespace
    serviceMonitorSelectorNilUsesHelmValues: false  # Pick up ALL ServiceMonitors
    ruleSelectorNilUsesHelmValues: false            # Pick up ALL PrometheusRules

defaultRules:
  create: false
  # WHY: The default rules fire alerts for things like nodes using > 85% disk.
  # These alerts flood the alertmanager with noise in a capstone environment.
```

### The Dual-Provisioning Bug (v65.1.1 — Fixed)

This is a real bug that caused CrashLoopBackOff during the project setup.

**What happened:**
kube-prometheus-stack v65 provisions Grafana datasources in TWO ways simultaneously:
1. A ConfigMap directly mounted into the Grafana pod at `/etc/grafana/provisioning/datasources/datasources.yaml` — with Prometheus as `isDefault: true`
2. A separate ConfigMap labeled `grafana_datasource: "1"` which the `grafana-sc-datasources` sidecar container picks up and also writes to that same directory — also with Prometheus as `isDefault: true`

Result: Two datasource files, both marking Prometheus as default. Grafana starts up, reads both, and throws:
```
msg="Only one datasource per organization can be marked as default"
```
Then crashes. Then restarts. Then crashes again. CrashLoopBackOff.

**The fix: `sidecar.datasources.enabled: false`**

This disables the sidecar container that picks up the labeled ConfigMap. Only the direct mount remains. One datasource file, one default — Grafana starts successfully.

### Grafana Dashboard Sources — How Dashboards Get Loaded

Grafana gets its dashboards from 3 distinct sources:

**Source 1 — Pre-built community dashboards (downloaded at startup)**
```yaml
# In monitoring-app.yaml helm values
dashboards:
  default:
    node-exporter-full:
      gnetId: 1860        # Grafana.com dashboard ID
      revision: 37
      datasource: Prometheus
    kubernetes-overview:  { gnetId: 15661 }
    kubernetes-workloads: { gnetId: 15760 }
    argocd:               { gnetId: 14584 }
```
Grafana downloads JSON from grafana.com at pod startup and stores in `/var/lib/grafana/dashboards/default/`. They appear in the "ShopMesh Kubernetes" folder.

**Source 2 — Custom dashboards via ConfigMap (the AWS Infrastructure dashboard)**
```yaml
# aws-dashboard-cm.yaml (in monitoring namespace)
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-infrastructure-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"     # MAGIC LABEL — grafana-sc-dashboard sidecar watches for this
  annotations:
    grafana_folder: "ShopMesh AWS"   # Put this dashboard in the "ShopMesh AWS" folder
data:
  aws-dashboard.json: |
    { "title": "ShopMesh AWS Infrastructure", "panels": [...] }
```

The `grafana-sc-dashboard` sidecar container (separate from the datasources sidecar — this one is enabled) runs in the Grafana pod and uses `kubectl watch` to find all ConfigMaps with `grafana_dashboard: "1"` across all namespaces. When it finds one, it copies the JSON to `/tmp/dashboards/ShopMesh AWS/`. Grafana's dashboard provider watches that directory and loads the dashboard.

**Source 3 — Direct datasource provisioning**
```yaml
datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        url: http://monitoring-prometheus:9090   # Internal cluster DNS
        isDefault: true
        access: proxy
      - name: CloudWatch
        type: cloudwatch
        jsonData:
          authType: default      # Uses pod's IRSA credentials automatically
          defaultRegion: us-east-1
```

**How Grafana uses IRSA for CloudWatch** — When a CloudWatch dashboard panel runs a query (e.g., "ALB request count"), Grafana's CloudWatch plugin calls `aws cloudwatch get-metric-data`. The AWS SDK inside Grafana reads the IRSA credentials (injected by EKS as env vars: `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`) and exchanges them for temporary creds to call CloudWatch. No access key is stored or configured.

### PrometheusRule Alerts

```yaml
# charts/monitoring/templates/prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: shopmesh-alerts
  namespace: production
  labels:
    release: monitoring    # Prometheus Operator selects rules with this label
spec:
  groups:
    - name: shopmesh.critical
      rules:
        - alert: NodeNotReady
          expr: kube_node_status_condition{condition="Ready",status="true"} == 0
          # Fires when: a node's Ready condition is false
          for: 5m           # Must be true for 5 continuous minutes before alerting
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.node }} is not ready"

        - alert: PodCrashLoopBackOff
          expr: kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",namespace="production"} == 1
          for: 5m
          # Fires when: any production pod is in CrashLoopBackOff for 5+ minutes

        - alert: ApplicationDown
          expr: kube_deployment_status_replicas_available{namespace="production"} == 0
          for: 5m
          # Fires when: any production deployment has 0 available replicas
```

Prometheus evaluates these expressions every 30 seconds. If the condition is true for 5 consecutive minutes, it sends a "firing" alert to AlertManager. AlertManager currently routes to `null` (silently drops). In a real production setup, it would route to PagerDuty or SNS → email.

---

## 16. Logging — Fluent Bit to CloudWatch

### Why Centralized Logging?

When there are 20+ pods running, logs are scattered. If a user reports an error at 2:14pm, you'd have to SSH into every node and search through files — practically impossible. Centralized logging collects ALL pod logs into one place where you can search across all services simultaneously.

### Fluent Bit — What It Is and How It Works

Fluent Bit is a log forwarder deployed as a **DaemonSet** — meaning Kubernetes guarantees exactly one Fluent Bit pod runs on EVERY node, always.

```
Every EKS Node:
├── Container runtime (containerd) writes pod logs to:
│     /var/log/containers/<pod-name>_<namespace>_<container-name>-<id>.log
│
└── Fluent Bit pod (mounted /var/log read-only)
      ├── INPUT: tail /var/log/containers/*.log
      │     Reads every new log line from every container on this node
      ├── FILTER: parse JSON, add metadata (namespace, pod name, container name)
      └── OUTPUT: cloudwatch_logs plugin
            Sends batches of log lines to CloudWatch
            Uses IRSA (shopmesh-irsa-fluent-bit role) — no stored credentials
```

**Helm values (fluent-bit-app.yaml):**
```yaml
cloudWatch:
  enabled: true
  region: us-east-1
  logGroupName: /shopmesh/eks      # All logs go to one log group
  logStreamPrefix: eks/            # Each pod gets: eks/<namespace>.<pod-name>
  autoCreateGroup: true            # Create the log group if it doesn't exist

tolerations:
  - operator: Exists               # Run on ALL nodes, including tainted ones
                                   # (Without this, won't run on nodes with taints)

serviceAccount:
  name: fluent-bit
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::242969680553:role/shopmesh-irsa-fluent-bit"
```

**Result in CloudWatch:**
```
Log Group: /shopmesh/eks
  Log Streams:
    eks/production.auth-service-7f9d4b-xkp2r.auth-service
    eks/production.order-service-6c8f3a-m4n7s.order-service
    eks/monitoring.monitoring-grafana-5f7c9d-p2q8t.grafana
    eks/kgateway-system.prod-86d9f4-k3r7n.envoy
    ...
```

### How Logs Flow to Grafana

The AI Assistant Grafana dashboard has a "Request Count" panel that queries CloudWatch Logs Insights:

```
CloudWatch Logs Insights query:
  fields @timestamp, @message
  | filter @logStream like /ai-assistant/
  | filter @message like "[BEDROCK] Converse API call"
  | stats count() as calls by bin(1m)
```

This shows: how many times per minute the AI assistant called Bedrock. The data comes from application logs (ai-assistant-service logs `[BEDROCK] Converse API call` for each request), collected by Fluent Bit, stored in CloudWatch, queried by Grafana via the CloudWatch datasource, using Grafana's IRSA role for authentication.

The entire pipeline from log line to dashboard is fully automated.

---

## 17. Security Architecture

### Defense in Depth — 5 Layers

ShopMesh uses multiple overlapping security layers. An attacker who bypasses one layer still faces the next:

```
LAYER 1 — EDGE (CloudFront)
╔══════════════════════════════════════════════════════╗
║  • HTTPS only — HTTP requests redirected to HTTPS    ║
║  • TLS 1.2 minimum (TLSv1.2_2021 policy)            ║
║  • ACM certificate (managed, auto-renewed by AWS)    ║
║  • WAF can be attached (not configured for capstone) ║
╚══════════════════════════════════════════════════════╝
           ↓ (HTTP to origin — inside AWS network)
LAYER 2 — LOAD BALANCER (ALB)
╔══════════════════════════════════════════════════════╗
║  • Security group: ONLY ports 80/443 from any IP     ║
║  • All other ports blocked by default (SG deny-all)  ║
║  • Health checks — traffic only to healthy pods      ║
║  • Access logs stored in S3 (audit trail)            ║
╚══════════════════════════════════════════════════════╝
           ↓ (to pod IP in private subnet)
LAYER 3 — NETWORK (VPC + Security Groups)
╔══════════════════════════════════════════════════════╗
║  • EKS nodes in PRIVATE subnets — no direct internet ║
║  • Node SG: inbound port 80/3000 only from ALB SG   ║
║  • Inter-pod: unrestricted within cluster (for DNS)  ║
║  • NAT Gateway: pods can call out, not in            ║
╚══════════════════════════════════════════════════════╝
           ↓ (to container inside pod)
LAYER 4 — POD (Kubernetes NetworkPolicy)
╔══════════════════════════════════════════════════════╗
║  • NetworkPolicy: accept inbound only from VPC CIDR  ║
║    (10.0.0.0/16) on service port                     ║
║  • Even pod-to-pod calls from outside VPC blocked    ║
║  • IRSA: each pod only has its own IAM permissions   ║
║  • No cross-service secret access                    ║
╚══════════════════════════════════════════════════════╝
           ↓ (to AWS data store)
LAYER 5 — DATA (IAM + Encryption)
╔══════════════════════════════════════════════════════╗
║  • DynamoDB: IRSA role per table per service         ║
║  • S3: bucket policy restricts to product-service    ║
║  • Secrets Manager: only external-secrets role reads ║
║  • All data encrypted at rest (AWS-managed KMS)      ║
║  • All traffic encrypted in transit (TLS/HTTPS)      ║
╚══════════════════════════════════════════════════════╝
```

### IMDS Hop Limit — Why It's Set to 2

EC2 Instance Metadata Service (IMDS) is at `169.254.169.254`. Normally (hop limit 1), only the EC2 instance itself can reach it. Containers inside pods are one network hop away from the instance, so they'd be blocked.

IRSA requires pods to reach IMDS for initial credential bootstrap. The launch template sets:
```hcl
metadata_options {
  http_endpoint               = "enabled"
  http_tokens                 = "required"   # IMDSv2 required (prevents SSRF)
  http_put_response_hop_limit = 2            # Allow pods (1 hop) to reach IMDS
}
```

`http_tokens = "required"` (IMDSv2) means: to access metadata, you must first get a session token with a PUT request. Simple GET requests to `169.254.169.254` (like Server-Side Request Forgery attacks) are rejected.

### GitHub Actions Security — The OIDC Flow

```
OLD WAY (what we don't do):
  GitHub Secret: AWS_ACCESS_KEY_ID = "AKIA..."   ← stored forever, rotation is manual
  GitHub Secret: AWS_SECRET_ACCESS_KEY = "..."

NEW WAY (what we do):
  No secrets stored at all
  
  When workflow runs:
  1. GitHub generates a short-lived JWT (valid ~5 minutes)
     JWT contains: { sub: "repo:shopmesh-final/shopmesh-app:ref:refs/heads/main" }
  
  2. GitHub Actions sends this JWT to AWS STS:
     sts:AssumeRoleWithWebIdentity(
       RoleArn: "arn:aws:iam::242969680553:role/shopmesh-github-actions-ecr",
       WebIdentityToken: "<the JWT>"
     )
  
  3. STS validates JWT against the GitHub OIDC provider (registered in IAM)
  4. STS checks the role's trust policy: does sub match "repo:shopmesh-final/shopmesh-app:*"?
  5. If yes: returns temporary credentials (valid 1 hour)
  
  If someone forks the repo and tries to use these credentials from their fork:
  → Their fork is "repo:attacker/fork:*" which doesn't match the trust condition
  → STS denies the request
```

### Secrets Management Rules

```
NEVER DO THIS:
  # In a ConfigMap (readable by any pod in the namespace):
  JWT_SECRET: "mysecretkey"

  # In a Deployment env:
  env:
    - name: JWT_SECRET
      value: "mysecretkey"   # Shows up in kubectl describe, logs, manifests

  # In a git-committed YAML file:
  JWT_SECRET=mysecretkey   # Now in git history forever

ALWAYS DO THIS:
  # Store in AWS Secrets Manager:
  aws secretsmanager put-secret-value \
    --secret-id shopmesh/jwt-secret \
    --secret-string '{"jwt_secret":"actualvalue"}'
  
  # Define ExternalSecret CRD in Helm chart
  # ESO fetches it, creates Kubernetes Secret
  # Pod reads from Kubernetes Secret via envFrom.secretRef
  
  # Result: secret is never in any YAML file, never in git, never in a ConfigMap
```

---

## 18. Key References — URLs, Credentials, ARNs

### Access Points

| Resource | URL | Credentials |
|---------|-----|------------|
| Application | https://shopmesh.shop | (public) |
| Grafana | https://shopmesh.shop/grafana | admin / prom-operator |
| ArgoCD | https://a06e82a5bf1664566937affc65f039b3-2139524823.us-east-1.elb.amazonaws.com | admin / saichandu123 |

### AWS Resource IDs

| Resource | ID / Name |
|---------|----------|
| AWS Account | `242969680553` |
| Region | `us-east-1` |
| EKS Cluster | `shopmesh-prod` |
| VPC | `10.0.0.0/16` |
| CloudFront Distribution | `E1N9Y9KYLN4Q4I` |
| CloudFront Domain | `d3sd0da2hnk8ea.cloudfront.net` |
| ECR Registry | `242969680553.dkr.ecr.us-east-1.amazonaws.com` |
| Bedrock Account | `686591366739` |

### Namespace Map

| Namespace | What Runs There |
|----------|----------------|
| `production` | frontend, auth-service, product-service, order-service, analytics-service, ai-assistant-service |
| `monitoring` | Prometheus, Grafana, AlertManager, node-exporter, kube-state-metrics |
| `argocd` | ArgoCD server, repo-server, application-controller, dex, redis |
| `kube-system` | AWS Load Balancer Controller, EBS CSI driver, kube-proxy, CoreDNS, metrics-server |
| `kgateway-system` | kgateway controller, Envoy proxy pod (`prod`) |
| `external-secrets` | External Secrets Operator |
| `amazon-cloudwatch` | Fluent Bit DaemonSet |

### Critical IRSA Role ARNs

```
shopmesh-irsa-auth-service         → arn:aws:iam::242969680553:role/shopmesh-irsa-auth-service
shopmesh-irsa-product-service      → arn:aws:iam::242969680553:role/shopmesh-irsa-product-service
shopmesh-irsa-order-service        → arn:aws:iam::242969680553:role/shopmesh-irsa-order-service
shopmesh-irsa-analytics-service    → arn:aws:iam::242969680553:role/shopmesh-irsa-analytics-service
shopmesh-irsa-ai-assistant-service → arn:aws:iam::242969680553:role/shopmesh-irsa-ai-assistant-service
shopmesh-irsa-external-secrets     → arn:aws:iam::242969680553:role/shopmesh-irsa-external-secrets
shopmesh-irsa-aws-lb-controller    → arn:aws:iam::242969680553:role/shopmesh-irsa-aws-lb-controller
shopmesh-irsa-cloudwatch-agent     → arn:aws:iam::242969680553:role/shopmesh-irsa-cloudwatch-agent
shopmesh-irsa-fluent-bit           → arn:aws:iam::242969680553:role/shopmesh-irsa-fluent-bit
shopmesh-irsa-ebs-csi              → arn:aws:iam::242969680553:role/shopmesh-irsa-ebs-csi
shopmesh-irsa-grafana              → arn:aws:iam::242969680553:role/shopmesh-irsa-grafana
```

### Kubernetes Commands Reference

```bash
# View all pods across namespaces
kubectl get pods -A

# Watch rolling update in progress
kubectl rollout status deployment/auth-service -n production

# See pod logs (live)
kubectl logs -f deployment/auth-service -n production

# Check HPA scaling status
kubectl get hpa -n production

# Check ArgoCD app status
kubectl get applications -n argocd

# Check which pod IPs are in the ALB target group
kubectl get targetgroupbinding -A

# Force ArgoCD to sync immediately
kubectl annotate application auth-service -n argocd argocd.argoproj.io/refresh=normal

# Describe ExternalSecret sync status
kubectl describe externalsecret auth-service-secret -n production

# Check Fluent Bit is running on all nodes
kubectl get ds -n amazon-cloudwatch

# View IRSA token inside a pod (for debugging)
kubectl exec -it <pod> -n production -- cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token
```

---

*ShopMesh Capstone — June 2026 — Account 242969680553 — us-east-1*
