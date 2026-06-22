variable "project_name" {
  description = "Project name prefix used in resource tags"
  type        = string
}

variable "domain_name" {
  description = "Apex domain for the hosted zone (e.g. example.com)"
  type        = string
}

variable "cert_validation_options" {
  description = "Merged domain_validation_options from all ACM certificates. Duplicates are collapsed by domain_name key."
  type = list(object({
    domain_name           = string
    resource_record_name  = string
    resource_record_type  = string
    resource_record_value = string
  }))
}
