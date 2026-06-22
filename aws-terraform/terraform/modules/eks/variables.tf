variable "project_name" { type = string }

variable "private_subnet_ids" { type = list(string) }
variable "public_subnet_ids" { type = list(string) }

variable "cluster_version" {
  type    = string
  default = "1.30"
}

variable "node_instance_type" {
  type    = list(string)
  default = ["t3.medium"]
}

# variable "node_min_size"     { type = number; default = 2 }
# variable "node_desired_size" { type = number; default = 2 }
# variable "node_max_size"     { type = number; default = 6 }
# variable "node_disk_size"    { type = number; default = 50 }

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_desired_size" {
  type    = number
  default = 3
}

variable "node_max_size" {
  type    = number
  default = 4
}

variable "node_disk_size" {
  type    = number
  default = 50
}