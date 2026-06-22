variable "project_name" { type = string }

variable "additional_role_arns" {
  description = "IAM role ARNs that need SQS access (IRSA roles)"
  type        = list(string)
  default     = []
}
