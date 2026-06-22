# ─── ECR Repositories ─────────────────────────────────────────────────────

resource "aws_ecr_repository" "frontend" {
  name                 = "${var.project_name}/frontend"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-frontend-ecr"
  }
}

resource "aws_ecr_repository" "auth_service" {
  name                 = "${var.project_name}/auth-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-auth-service-ecr"
  }
}

resource "aws_ecr_repository" "product_service" {
  name                 = "${var.project_name}/product-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-product-service-ecr"
  }
}

resource "aws_ecr_repository" "order_service" {
  name                 = "${var.project_name}/order-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-order-service-ecr"
  }
}

# ─── Lifecycle Policy (keep last 10 images) ───────────────────────────────
locals {
  lifecycle_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "frontend" {
  repository = aws_ecr_repository.frontend.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "auth_service" {
  repository = aws_ecr_repository.auth_service.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "product_service" {
  repository = aws_ecr_repository.product_service.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "order_service" {
  repository = aws_ecr_repository.order_service.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_repository" "analytics_service" {
  name                 = "${var.project_name}/analytics-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-analytics-service-ecr"
  }
}

resource "aws_ecr_lifecycle_policy" "analytics_service" {
  repository = aws_ecr_repository.analytics_service.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_repository" "ai_assistant_service" {
  name                 = "${var.project_name}/ai-assistant-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-ai-assistant-service-ecr"
  }
}

resource "aws_ecr_lifecycle_policy" "ai_assistant_service" {
  repository = aws_ecr_repository.ai_assistant_service.name
  policy     = local.lifecycle_policy
}
