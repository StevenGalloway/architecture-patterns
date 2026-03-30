# Orders Data Product

## Purpose
Provide trustworthy, domain-owned order lifecycle data for analytics and downstream operational consumers.

## Contract
See `contract.yaml`.

## SLOs
- Freshness: <= 30 minutes
- Availability: 99.5%

## Key Entities
- `orders_raw` (source-aligned)
- `orders_curated` (cleaned, conformed)
- `orders_metrics_daily` (aggregates)

## Consumer Examples
- Revenue by day/week/month
- Order completion and cancellation rates
- Cohort analysis by channel

## Ownership
- Team: Orders Domain
- Contact: #data-orders (Slack)
