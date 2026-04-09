# Route53 latency-based routing with health checks (simplified)
data "aws_route53_zone" "zone" {
  name         = var.domain_name
  private_zone = false
}

resource "aws_route53_health_check" "r1" {
  fqdn              = var.region1_alb_dns
  port              = 80
  type              = "HTTP"
  resource_path     = "/"
  failure_threshold = 3
  request_interval  = 30
}

resource "aws_route53_health_check" "r2" {
  fqdn              = var.region2_alb_dns
  port              = 80
  type              = "HTTP"
  resource_path     = "/"
  failure_threshold = 3
  request_interval  = 30
}

resource "aws_route53_record" "r1" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = "${var.service_subdomain}.${var.domain_name}"
  type    = "A"
  set_identifier = "region-1"
  health_check_id = aws_route53_health_check.r1.id

  alias {
    name                   = var.region1_alb_dns
    zone_id                = var.region1_alb_zoneid
    evaluate_target_health = true
  }

  latency_routing_policy { region = "us-east-1" }
}

resource "aws_route53_record" "r2" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = "${var.service_subdomain}.${var.domain_name}"
  type    = "A"
  set_identifier = "region-2"
  health_check_id = aws_route53_health_check.r2.id

  alias {
    name                   = var.region2_alb_dns
    zone_id                = var.region2_alb_zoneid
    evaluate_target_health = true
  }

  latency_routing_policy { region = "us-west-2" }
}

output "fqdn" {
  value = aws_route53_record.r1.name
}
