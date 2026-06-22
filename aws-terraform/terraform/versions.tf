terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.44.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    bucket         = "shopmesh-terraform-state-242969680553"
    key            = "shopmesh/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "shopmesh-terraform-locks"
    encrypt        = true
  }
}









# terraform {
#   required_version = ">= 1.6.0"

#   required_providers {
#     aws = {
#       source  = "hashicorp/aws"
#       version = "6.44.0"
#     }
#   }

#   # ─── Remote State Backend ─────────────────────────────────────────────
#   # STEP 1: Run terraform/bootstrap/ first to create the bucket and table.
#   # STEP 2: Replace ACCOUNT_ID below with your 12-digit AWS account ID.
#   #         Command: aws sts get-caller-identity --query Account --output text
#   # STEP 3: Run: terraform init -migrate-state
#   # backend block values MUST be string literals — variables are not allowed here.
#   backend "s3" {
#     bucket         = "shopmesh-terraform-state-ACCOUNT_ID"
#     key            = "shopmesh/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "shopmesh-terraform-locks"
#     encrypt        = true
#   }
# }
