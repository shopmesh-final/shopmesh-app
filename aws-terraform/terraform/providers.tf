provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# ACM certificates for CloudFront MUST live in us-east-1 regardless of the
# deployment region.  This alias is used only for those two ACM resources in
# main.tf — no child module receives the aliased provider.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}



# provider "aws" {
#   region = var.aws_region

#   default_tags {
#     tags = {
#       Project     = var.project_name
#       Environment = var.environment
#       ManagedBy   = "Terraform"
#     }
#   }
# }

# # provider "random" {}


# terraform {
#   required_providers {
#     aws = {
#         source = "registry.terraform.io/hashicorp/aws"
#         version = "6.44.0"
#     }
#   }
# }


