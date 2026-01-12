# ADR-005: Standardize request IDs and distributed tracing propagation

## Status
Accepted

## Context
Without consistent telemetry, diagnosing failures across services is slow and error-prone.

## Decision
- Gateway generates a request_id if missing
- Gateway propagates W3C trace context headers downstream
- Structured access logs emitted for every request:
  - request_id, route, upstream, status, latency, tenant_id (non-PII)

## Consequences
### Positive
- Faster incident resolution and root cause analysis
- Supports SLOs and alerting at the edge

### Negative
- Increased logging volume and cost
- Must avoid logging PII
