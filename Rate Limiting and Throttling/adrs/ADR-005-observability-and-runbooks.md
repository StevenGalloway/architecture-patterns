# ADR-005: Observability and runbooks for rate limits

## Status
Accepted

## Date
2026-01-11

## Context
Limits require ongoing tuning; we must distinguish “abuse” from “legitimate growth” and diagnose incidents quickly.

## Decision
Track and alert on:
- 429 rate per route / per API key / per IP
- Redis latency/errors
- backend latency + error rates during enforcement
Maintain runbooks:
- how to raise limits safely (tier-based)
- how to block abusive keys and enable WAF rules
- how to validate changes via canary

## Consequences
- safer operations and faster incident response
- requires dashboards and ownership
