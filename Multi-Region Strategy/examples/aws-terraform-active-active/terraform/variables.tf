variable "region_1" { type = string default = "us-east-1" }
variable "region_2" { type = string default = "us-west-2" }

variable "domain_name" { type = string default = "example.com" }
variable "service_subdomain" { type = string default = "service" }

variable "image" { type = string default = "public.ecr.aws/nginx/nginx:latest" }

variable "desired_count" { type = number default = 2 }
