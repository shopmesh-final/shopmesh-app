output "frontend_repository_url" {
  description = "ECR repository URL for the frontend image"
  value       = aws_ecr_repository.frontend.repository_url
}

output "auth_repository_url" {
  description = "ECR repository URL for the auth-service image"
  value       = aws_ecr_repository.auth_service.repository_url
}

output "product_repository_url" {
  description = "ECR repository URL for the product-service image"
  value       = aws_ecr_repository.product_service.repository_url
}

output "order_repository_url" {
  description = "ECR repository URL for the order-service image"
  value       = aws_ecr_repository.order_service.repository_url
}

output "analytics_repository_url" {
  description = "ECR repository URL for the analytics-service image"
  value       = aws_ecr_repository.analytics_service.repository_url
}

output "ai_assistant_repository_url" {
  description = "ECR repository URL for the ai-assistant-service image"
  value       = aws_ecr_repository.ai_assistant_service.repository_url
}
