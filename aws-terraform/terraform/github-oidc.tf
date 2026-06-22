# ─── GitHub Actions OIDC Provider ────────────────────────────────────────
# Allows GitHub Actions runners to exchange a JWT token for AWS credentials
# via sts:AssumeRoleWithWebIdentity — no stored AWS keys anywhere.
#
# IMPORT: If this provider already exists in the account run:
#   terraform import aws_iam_openid_connect_provider.github_actions \
#     arn:aws:iam::242969680553:oidc-provider/token.actions.githubusercontent.com
resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = { Name = "${local.project_name}-github-actions-oidc" }
}

# ─── GitHub Actions IAM Role ──────────────────────────────────────────────
# Scoped strictly to shopmesh-final/shopmesh-app — no other repo can assume it.
resource "aws_iam_role" "github_actions" {
  name = "${local.project_name}-github-actions-ecr"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github_actions.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:shopmesh-final/shopmesh-app:*"
        }
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = { Name = "${local.project_name}-github-actions-ecr" }
}

# ─── ECR Push Policy ──────────────────────────────────────────────────────
# ecr:GetAuthorizationToken must target "*" (AWS requirement — no resource-level scoping).
# All push/pull actions are scoped to the 6 ShopMesh repositories only.
resource "aws_iam_role_policy" "github_actions_ecr" {
  name = "ecr-push"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = [
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/auth-service",
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/product-service",
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/order-service",
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/analytics-service",
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/ai-assistant-service",
          "arn:aws:ecr:${local.aws_region}:${local.account_id}:repository/shopmesh/frontend",
        ]
      },
    ]
  })
}
