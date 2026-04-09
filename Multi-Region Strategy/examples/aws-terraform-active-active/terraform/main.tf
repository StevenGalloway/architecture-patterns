# NOTE: This is a skeleton. For production, split into modules and add full networking, IAM, and security controls.

module "region1" {
  source = "./modules/region-stack"
  providers = { aws = aws.r1 }

  region_name   = var.region_1
  image         = var.image
  desired_count = var.desired_count
}

module "region2" {
  source = "./modules/region-stack"
  providers = { aws = aws.r2 }

  region_name   = var.region_2
  image         = var.image
  desired_count = var.desired_count
}

# Multi-region state (DynamoDB Global Table)
module "global_table" {
  source = "./modules/dynamodb-global-table"
  providers = {
    aws.r1 = aws.r1
    aws.r2 = aws.r2
  }
  table_name = "session_state"
}

# Global routing (Route53 latency + health checks)
module "global_dns" {
  source = "./modules/route53-latency-dns"
  providers = { aws = aws.r1 } # Route53 is global; any region provider works

  domain_name        = var.domain_name
  service_subdomain  = var.service_subdomain
  region1_alb_dns    = module.region1.alb_dns_name
  region2_alb_dns    = module.region2.alb_dns_name
  region1_alb_zoneid = module.region1.alb_zone_id
  region2_alb_zoneid = module.region2.alb_zone_id
}
