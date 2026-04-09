terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  alias  = "r1"
  region = var.region_1
}

provider "aws" {
  alias  = "r2"
  region = var.region_2
}
