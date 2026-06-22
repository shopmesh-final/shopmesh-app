locals {
  project_name = var.project_name
  aws_region   = var.aws_region
  environment  = var.environment
  account_id   = "242969680553"

  # Computed ARNs for breaking circular dependencies (sqs↔irsa)
  sqs_order_queue_arn = "arn:aws:sqs:${var.aws_region}:242969680553:${var.project_name}-order-processing"
}

# ─── ACM Certificates ─────────────────────────────────────────────────────
# One cert per region:
#   • alb       → default region  (us-east-1)  — attached to ALB HTTPS listener
#   • cloudfront → forced us-east-1             — CloudFront requirement
# Both share the same domain_name so they produce the same DNS validation CNAME.
# Route53 creates that CNAME automatically; no manual DNS work required.

resource "aws_acm_certificate" "alb" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.project_name}-alb-cert" }
}

resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.project_name}-cloudfront-cert" }
}

# ─── Route53 ──────────────────────────────────────────────────────────────
# Creates:
#   1. Hosted zone for var.domain_name
#   2. ACM CNAME validation records (auto-validates both certs above)
#   3. A alias record: domain_name → CloudFront
#   4. A alias record: www.domain_name → CloudFront
#
# IMPORTANT: After first `terraform apply`, run:
#   terraform output route53_name_servers
# Then update your domain registrar to use these 4 NS records.
# Route53 validation is instant once NS records propagate (minutes–hours).

module "route53" {
  source       = "./modules/route53"
  project_name = local.project_name
  domain_name  = var.domain_name

  # Merge validation options from both certs — duplicate domain_name keys are
  # collapsed in the module's for_each (they produce identical CNAME values).
  # Build a map keyed by domain_name first (deduplicates identical CNAME entries
  # produced by both certs for the same domain), then convert back to a list.
  cert_validation_options = [
    for key, dvos in {
      for dvo in concat(
        [for dvo in aws_acm_certificate.alb.domain_validation_options : {
          domain_name           = dvo.domain_name
          resource_record_name  = dvo.resource_record_name
          resource_record_type  = dvo.resource_record_type
          resource_record_value = dvo.resource_record_value
        }],
        [for dvo in aws_acm_certificate.cloudfront.domain_validation_options : {
          domain_name           = dvo.domain_name
          resource_record_name  = dvo.resource_record_name
          resource_record_type  = dvo.resource_record_type
          resource_record_value = dvo.resource_record_value
        }]
      ) : dvo.domain_name => dvo...
    } : dvos[0]
  ]
}

# Wait for both ACM certs to reach ISSUED state.
# Terraform blocks here until Route53 propagates the validation CNAME
# (typically 1–5 minutes after NS records are in place at the registrar).

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = module.route53.acm_validation_record_fqdns

  timeouts {
    create = "15m"
  }
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = module.route53.acm_validation_record_fqdns

  timeouts {
    create = "15m"
  }
}

# ─── VPC ──────────────────────────────────────────────────────────────────
module "vpc" {
  source               = "./modules/vpc"
  project_name         = local.project_name
  aws_region           = local.aws_region
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  availability_zones   = var.availability_zones
}

# ─── Security Groups ──────────────────────────────────────────────────────
module "security_groups" {
  source       = "./modules/security-groups"
  project_name = local.project_name
  vpc_id       = module.vpc.vpc_id
}

# ─── EventBridge IAM Role ─────────────────────────────────────────────────
# Extracted here now that the EC2 IAM module is removed.
resource "aws_iam_role" "eventbridge" {
  name = "${local.project_name}-eventbridge-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "eventbridge_sns" {
  name = "${local.project_name}-eventbridge-sns"
  role = aws_iam_role.eventbridge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = ["arn:aws:sns:${local.aws_region}:${local.account_id}:${local.project_name}-*"]
    }]
  })
}

# ─── S3 ───────────────────────────────────────────────────────────────────
module "s3" {
  source       = "./modules/s3"
  project_name = local.project_name
}

# ─── DynamoDB ─────────────────────────────────────────────────────────────
module "dynamodb" {
  source       = "./modules/dynamodb"
  project_name = local.project_name
}

# ─── Secrets Manager ──────────────────────────────────────────────────────
module "secretsmanager" {
  source       = "./modules/secretsmanager"
  project_name = local.project_name
  aws_region   = local.aws_region
}

# ─── SNS ──────────────────────────────────────────────────────────────────
module "sns" {
  source       = "./modules/sns"
  project_name = local.project_name
  alert_email  = var.alert_email
}

# ─── SQS ──────────────────────────────────────────────────────────────────
module "sqs" {
  source               = "./modules/sqs"
  project_name         = local.project_name
  additional_role_arns = [module.irsa.order_service_role_arn]
}

# ─── ECR ──────────────────────────────────────────────────────────────────
module "ecr" {
  source       = "./modules/ecr"
  project_name = local.project_name
}

# ─── EKS ──────────────────────────────────────────────────────────────────
module "eks" {
  source             = "./modules/eks"
  project_name       = local.project_name
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids
  cluster_version    = var.eks_cluster_version
  node_instance_type = var.eks_node_instance_type
  node_min_size      = var.eks_node_min_size
  node_desired_size  = var.eks_node_desired_size
  node_max_size      = var.eks_node_max_size
  node_disk_size     = 50

  depends_on = [module.vpc]
}

# ─── IRSA ─────────────────────────────────────────────────────────────────
module "irsa" {
  source       = "./modules/irsa"
  project_name = local.project_name
  aws_region   = local.aws_region
  account_id   = "242969680553"

  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_issuer_url   = module.eks.cluster_oidc_issuer_url

  dynamodb_users_table_arn     = "arn:aws:dynamodb:${local.aws_region}:242969680553:table/${local.project_name}-users"
  dynamodb_products_table_arn  = "arn:aws:dynamodb:${local.aws_region}:242969680553:table/${local.project_name}-products"
  dynamodb_orders_table_arn    = "arn:aws:dynamodb:${local.aws_region}:242969680553:table/${local.project_name}-orders"
  s3_product_images_bucket_arn = module.s3.product_images_bucket_arn
  sns_orders_topic_arn         = module.sns.orders_topic_arn
  sns_alerts_topic_arn         = module.sns.alerts_topic_arn
  sqs_order_queue_arn          = local.sqs_order_queue_arn

  depends_on = [module.eks]
}

# ─── CloudWatch Observability Add-on ─────────────────────────────────────
# Declared here (not inside module "eks") so we can reference module.irsa.cloudwatch_agent_role_arn
# without creating a circular dependency between the eks and irsa modules.
resource "aws_eks_addon" "cloudwatch_observability" {
  cluster_name                = module.eks.cluster_name
  addon_name                  = "amazon-cloudwatch-observability"
  service_account_role_arn    = module.irsa.cloudwatch_agent_role_arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [module.eks, module.irsa]
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = module.eks.cluster_name
  addon_name                  = "aws-ebs-csi-driver"
  service_account_role_arn    = module.irsa.ebs_csi_role_arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [module.eks, module.irsa]
}

# ─── ALB ──────────────────────────────────────────────────────────────────
module "alb" {
  source             = "./modules/alb"
  project_name       = local.project_name
  vpc_id             = module.vpc.vpc_id
  public_subnet_ids  = module.vpc.public_subnet_ids
  external_alb_sg_id = module.security_groups.external_alb_sg_id
  alb_logs_bucket    = module.s3.alb_logs_bucket_name
  certificate_arn    = aws_acm_certificate_validation.alb.certificate_arn
}

# # ─── CloudFront ───────────────────────────────────────────────────────────
# module "cloudfront" {
#   source                 = "./modules/cloudfront"
#   project_name           = local.project_name
#   external_alb_dns_name  = module.alb.external_alb_dns_name
#   cloudfront_logs_bucket = module.s3.cloudfront_logs_bucket_name
#   price_class            = var.cloudfront_price_class
#   certificate_arn        = aws_acm_certificate_validation.cloudfront.certificate_arn
#   domain_name            = var.domain_name
# }

# ─── Route53 A Records (CloudFront alias) ─────────────────────────────────
# Created after both module.route53 (zone) and module.cloudfront (distribution)
# are ready. This avoids the circular dependency that would occur if these
# records lived inside the route53 module.

# resource "aws_route53_record" "cloudfront_alias" {
#   zone_id = module.route53.zone_id
#   name    = var.domain_name
#   type    = "A"

#   alias {
#     name                   = module.cloudfront.cloudfront_domain_name
#     zone_id                = "Z2FDTNDATAQYW2" # CloudFront hosted zone ID (fixed AWS constant)
#     evaluate_target_health = false
#   }
# }

# resource "aws_route53_record" "www_alias" {
#   count   = var.create_www_record ? 1 : 0
#   zone_id = module.route53.zone_id
#   name    = "www.${var.domain_name}"
#   type    = "A"

#   alias {
#     name                   = module.cloudfront.cloudfront_domain_name
#     zone_id                = "Z2FDTNDATAQYW2"
#     evaluate_target_health = false
#   }
# }

# ─── EventBridge ──────────────────────────────────────────────────────────
module "eventbridge" {
  source               = "./modules/eventbridge"
  project_name         = local.project_name
  orders_topic_arn     = module.sns.orders_topic_arn
  alerts_topic_arn     = module.sns.alerts_topic_arn
  eventbridge_role_arn = aws_iam_role.eventbridge.arn
}
