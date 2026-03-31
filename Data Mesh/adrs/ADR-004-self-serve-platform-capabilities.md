# ADR-004: Provide a self-serve data platform (paved road)

## Status
Accepted

## Date
2026-01-11

## Context
Domain teams need standardized tooling to publish products without deep platform expertise.

## Decision
Platform provides:
- ingestion + orchestration templates
- metadata catalog + lineage
- compute/storage provisioning and cost visibility
- secure access patterns (RBAC, encryption, secrets)

## Consequences
- faster domain onboarding and fewer bespoke pipelines
- platform becomes critical shared infrastructure requiring SLOs and on-call
