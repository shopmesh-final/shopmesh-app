variable "project_name" {
  type = string
}

variable "external_alb_dns_name" {
  type = string
}

variable "cloudfront_logs_bucket" {
  type = string
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "certificate_arn" {
  description = "ARN of validated ACM certificate in us-east-1 for CloudFront"
  type        = string
}

variable "domain_name" {
  description = "Custom domain name served by this CloudFront distribution (e.g. shop.example.com)"
  type        = string
}
