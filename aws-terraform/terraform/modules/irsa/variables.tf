variable "project_name" { type = string }
variable "aws_region" { type = string }
variable "account_id" { type = string }

variable "oidc_provider_arn" { type = string }
variable "oidc_issuer_url" { type = string }

variable "dynamodb_users_table_arn" { type = string }
variable "dynamodb_products_table_arn" { type = string }
variable "dynamodb_orders_table_arn" { type = string }
variable "s3_product_images_bucket_arn" { type = string }
variable "sns_orders_topic_arn" { type = string }
variable "sns_alerts_topic_arn" { type = string }
variable "sqs_order_queue_arn" { type = string }
