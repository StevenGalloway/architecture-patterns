# Terraform (Active/Active Multi-Region Skeleton)

This Terraform skeleton is designed to be readable and “production-mappable”:
- two providers (Region A + Region B)
- VPC + ECS Fargate + ALB per region
- Route53 latency records + health checks
- DynamoDB Global Table for cross-region state

It is intentionally simplified: networking, IAM and security hardening should be expanded for real deployments.
