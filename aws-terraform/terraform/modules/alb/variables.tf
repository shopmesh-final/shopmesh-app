variable "project_name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "external_alb_sg_id" { type = string }
variable "alb_logs_bucket" { type = string }

variable "certificate_arn" {
  description = "ACM certificate ARN (validated) for the external ALB HTTPS listener"
  type        = string
}
