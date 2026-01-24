# ADR-004: Add contract tests for vendor payloads and mappings

## Status
Accepted

## Date
2026-01-11

## Context
Vendor payload drift can silently break integrations. We need early detection in CI and monitoring in production.

## Decision
- Add schema/contract tests validating known vendor fields
- Add mapping tests: VendorDTO -> CanonicalCustomer
- In production, log unknown fields and mapping failures as metrics

## Consequences
- Faster detection of vendor changes
- Requires maintaining fixtures and updating tests when vendor evolves
