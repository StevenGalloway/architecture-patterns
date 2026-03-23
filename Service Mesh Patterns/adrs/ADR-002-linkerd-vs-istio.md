# ADR-002: Choose Linkerd for a lightweight, operationally simple mesh

## Status
Accepted

## Date
2026-01-11

## Context
We need mesh capabilities without excessive operational burden, and we prioritize reliability and ease of operation.

## Decision
Select **Linkerd** as the default service mesh for the platform due to:
- lightweight Rust-based proxy
- strong mTLS defaults and observability
- simpler operational model for many teams

## Consequences
- faster adoption and lower toil for platform/SRE
- for advanced L7 routing/policy needs, Istio may be evaluated for specific domains
