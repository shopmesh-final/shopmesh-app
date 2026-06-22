# ─── Networking ───────────────────────────────────────────────────────────
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = module.vpc.public_subnet_ids
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = module.vpc.private_subnet_ids
}

# ─── Load Balancers ───────────────────────────────────────────────────────
output "external_alb_dns_name" {
  description = "External ALB DNS name (used as CloudFront origin)"
  value       = module.alb.external_alb_dns_name
}

# # ─── CloudFront ───────────────────────────────────────────────────────────
# output "cloudfront_domain_name" {
#   description = "CloudFront distribution domain — use this URL to access the application"
#   value       = module.cloudfront.cloudfront_domain_name
# }

# output "cloudfront_distribution_id" {
#   description = "CloudFront distribution ID"
#   value       = module.cloudfront.cloudfront_distribution_id
# }

# ─── DynamoDB ─────────────────────────────────────────────────────────────
output "dynamodb_users_table" {
  description = "DynamoDB Users table name"
  value       = module.dynamodb.users_table_name
}

output "dynamodb_products_table" {
  description = "DynamoDB Products table name"
  value       = module.dynamodb.products_table_name
}

output "dynamodb_orders_table" {
  description = "DynamoDB Orders table name"
  value       = module.dynamodb.orders_table_name
}

# ─── SQS ──────────────────────────────────────────────────────────────────
output "sqs_order_queue_url" {
  description = "SQS order processing queue URL"
  value       = module.sqs.order_queue_url
}

output "sqs_order_dlq_url" {
  description = "SQS order dead letter queue URL"
  value       = module.sqs.order_dlq_url
}

# ─── SNS ──────────────────────────────────────────────────────────────────
output "sns_alerts_topic_arn" {
  description = "SNS alerts topic ARN"
  value       = module.sns.alerts_topic_arn
}

output "sns_orders_topic_arn" {
  description = "SNS orders topic ARN"
  value       = module.sns.orders_topic_arn
}

# ─── Secrets Manager ──────────────────────────────────────────────────────
output "jwt_secret_arn" {
  description = "Secrets Manager JWT secret ARN"
  value       = module.secretsmanager.jwt_secret_arn
}

# ─── S3 ───────────────────────────────────────────────────────────────────
output "product_images_bucket" {
  description = "S3 product images bucket name"
  value       = module.s3.product_images_bucket_name
}

# ─── Route53 ──────────────────────────────────────────────────────────────
output "route53_zone_id" {
  description = "Route53 hosted zone ID"
  value       = module.route53.zone_id
}

output "route53_name_servers" {
  description = "NS records — update your domain registrar to use these 4 nameservers after first apply"
  value       = module.route53.name_servers
}

# ─── Application URL ──────────────────────────────────────────────────────
output "app_url" {
  description = "Public HTTPS URL of the application"
  value       = "https://${var.domain_name}"
}

# ─── EKS ──────────────────────────────────────────────────────────────────
output "eks_cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "eks_oidc_issuer_url" {
  description = "EKS OIDC issuer URL (used for IRSA trust policies)"
  value       = module.eks.cluster_oidc_issuer_url
}

output "eks_oidc_provider_arn" {
  description = "EKS OIDC provider ARN"
  value       = module.eks.oidc_provider_arn
}

# ─── IRSA Role ARNs ───────────────────────────────────────────────────────
output "irsa_auth_service_role_arn" {
  value = module.irsa.auth_service_role_arn
}

output "irsa_product_service_role_arn" {
  value = module.irsa.product_service_role_arn
}

output "irsa_order_service_role_arn" {
  value = module.irsa.order_service_role_arn
}

output "irsa_analytics_service_role_arn" {
  value = module.irsa.analytics_service_role_arn
}

output "irsa_ai_assistant_service_role_arn" {
  value = module.irsa.ai_assistant_service_role_arn
}

output "irsa_external_secrets_role_arn" {
  value = module.irsa.external_secrets_role_arn
}

output "irsa_aws_lb_controller_role_arn" {
  value = module.irsa.aws_lb_controller_role_arn
}

output "irsa_cloudwatch_agent_role_arn" {
  value = module.irsa.cloudwatch_agent_role_arn
}

output "irsa_fluent_bit_role_arn" {
  value = module.irsa.fluent_bit_role_arn
}

output "irsa_ebs_csi_role_arn" {
  value = module.irsa.ebs_csi_role_arn
}

# ─── ALB Target Group ARN for TargetGroupBinding ─────────────────────────
output "frontend_target_group_arn" {
  description = "Frontend ALB target group ARN — ip type, used by EKS TargetGroupBinding"
  value       = module.alb.frontend_target_group_arn
}

# ─── GitHub Actions ───────────────────────────────────────────────────────
output "github_actions_role_arn" {
  description = "IAM role ARN — set as AWS_CI_ROLE_ARN repository variable in shopmesh-app"
  value       = aws_iam_role.github_actions.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN"
  value       = aws_iam_openid_connect_provider.github_actions.arn
}
