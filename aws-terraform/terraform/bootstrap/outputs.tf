output "state_bucket_name" {
  description = "S3 bucket name for Terraform state — copy this into the backend block"
  value       = aws_s3_bucket.terraform_state.id
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state S3 bucket"
  value       = aws_s3_bucket.terraform_state.arn
}

output "dynamodb_table_name" {
  description = "DynamoDB lock table name — copy this into the backend block"
  value       = aws_dynamodb_table.terraform_locks.name
}

output "backend_config_block" {
  description = "Paste this block into terraform/versions.tf inside the terraform {} block"
  value       = <<-EOT

  backend "s3" {
    bucket         = "${aws_s3_bucket.terraform_state.id}"
    key            = "shopmesh/terraform.tfstate"
    region         = "${data.aws_region.current.name}"
    dynamodb_table = "${aws_dynamodb_table.terraform_locks.name}"
    encrypt        = true
  }

  EOT
}
