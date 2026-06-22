# ─── JWT Secret ──────────────────────────────────────────────────────────
data "aws_secretsmanager_secret" "jwt_secret" {
  name = "${var.project_name}/jwt-secret"
}


data "aws_secretsmanager_secret" "aws_config" {
  name = "${var.project_name}/app-config"

}

# # ─── JWT Secret ───────────────────────────────────────────────────────────
# resource "aws_secretsmanager_secret" "jwt_secret" {
#   name                    = "${var.project_name}/jwt-secret"
#   description             = "JWT signing secret for ShopMesh authentication"
#   recovery_window_in_days = 7
  
#   lifecycle {
#     prevent_destroy = true
#   }


#   tags = { Name = "${var.project_name}-jwt-secret" }
# }

# resource "aws_secretsmanager_secret_version" "jwt_secret" {
#   secret_id = aws_secretsmanager_secret.jwt_secret.id

#   secret_string = jsonencode({
#     jwt_secret = "ShopMeshDemoJWTSecret2026!"
#   })
  
#   lifecycle {
#     ignore_changes = [secret_string]
#   }

# }

# # ─── App Config Secret ────────────────────────────────────────────────────
# resource "aws_secretsmanager_secret" "app_config" {
#   name                    = "${var.project_name}/app-config"
#   description             = "Application configuration for ShopMesh"
#   recovery_window_in_days = 7
  
#   lifecycle {
#     prevent_destroy = true
#   }


#   tags = { Name = "${var.project_name}-app-config" }
# }

# resource "aws_secretsmanager_secret_version" "app_config" {
#   secret_id = aws_secretsmanager_secret.app_config.id

#   secret_string = jsonencode({
#     jwt_expires_in          = "24h"
#     dynamodb_users_table    = "${var.project_name}-users"
#     dynamodb_products_table = "${var.project_name}-products"
#     dynamodb_orders_table   = "${var.project_name}-orders"
#     aws_region              = var.aws_region
#   })
  
#   lifecycle {
#     ignore_changes = [secret_string]
#   }
# }
