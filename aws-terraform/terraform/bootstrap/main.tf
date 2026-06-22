# ─── Data Sources ─────────────────────────────────────────────────────────
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.name
  bucket_name = "shopmesh-terraform-state-${local.account_id}"
}

# ─── S3 Bucket for Terraform State ────────────────────────────────────────
resource "aws_s3_bucket" "terraform_state" {
  bucket = local.bucket_name

  # prevent_destroy guards against accidental deletion of the bucket that
  # holds the state for ALL shopmesh infrastructure. Removing this requires
  # a deliberate two-step: remove the lifecycle block, apply, then destroy.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = "shopmesh-terraform-state"
    Purpose = "Terraform remote state storage"
  }
}

# ─── Block all public access ───────────────────────────────────────────────
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ─── Versioning — required for state history and rollback ─────────────────
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ─── Server-side encryption ────────────────────────────────────────────────
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    # bucket_key_enabled reduces SSE-S3 request costs at high state-access volume
    bucket_key_enabled = true
  }
}

# ─── Lifecycle: clean up old non-current state versions ───────────────────
resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  # Versioning must be enabled before lifecycle rules can be created
  depends_on = [aws_s3_bucket_versioning.terraform_state]

  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      # Keep 90 days of state version history — sufficient for rollback
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      # Clean up failed multipart uploads after 7 days
      days_after_initiation = 7
    }
  }
}

# ─── DynamoDB Table for State Locking ─────────────────────────────────────
# This table prevents concurrent terraform apply operations from corrupting state.
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "shopmesh-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = "shopmesh-terraform-locks"
    Purpose = "Terraform state locking"
  }
}
