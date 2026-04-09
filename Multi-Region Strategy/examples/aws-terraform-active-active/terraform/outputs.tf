output "region1_endpoint" { value = module.region1.alb_dns_name }
output "region2_endpoint" { value = module.region2.alb_dns_name }
output "global_fqdn" { value = module.global_dns.fqdn }
