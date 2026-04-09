# Multi-Region Example (AWS + Terraform, Active/Active)

## What it demonstrates
- Two-region deployment (Region A + Region B)
- ECS/Fargate + ALB in each region (regional compute stacks)
- Route 53 latency routing + health checks (global traffic management)
- DynamoDB Global Tables (multi-active state)
- Runbooks for failover drills and incident scenarios

## Run (high-level)
1) Configure AWS credentials with access to:
- Route53 hosted zone for your domain
- ECS, ALB, VPC, IAM, DynamoDB

2) Initialize and apply Terraform
```bash
cd terraform
terraform init
terraform apply
```

3) Test global routing
```bash
../scripts/smoke-test.sh service.example.com
```

## Notes
- This is a *skeleton* meant to be readable and architecturally accurate.
- For production: add private subnets, NAT, WAF, autoscaling, IAM least privilege, encryption, logging, and cost controls.
- Consider AWS Global Accelerator for faster traffic steering than DNS in some cases.
