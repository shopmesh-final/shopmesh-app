terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.44.0"
    }
  }
}

#   backend "s3" {
#     bucket         = "shopmesh-terraform-state-ACCOUNT_ID"
#     key            = "shopmesh/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "shopmesh-terraform-locks"
#     encrypt        = true
#   }
# }



# terraform {
#   required_version = ">= 1.6.0"

#   required_providers {
#     aws = {
#       source  = "hashicorp/aws"
#       version = "6.44.0"
#     }
#   }
#   # NO backend block — this bootstrap config intentionally keeps its own
#   # state local. It must never depend on the backend it is creating.
# }

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "shopmesh"
      Environment = "prod"
      ManagedBy   = "Terraform-Bootstrap"
    }
  }
}
