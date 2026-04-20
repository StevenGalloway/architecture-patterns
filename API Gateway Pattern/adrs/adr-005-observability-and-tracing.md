# ADR-005: Standardize request IDs, structured access logs, and distributed trace propagation

## Status
Accepted

## Date
2025-11-26

## Context
After the gateway was in production for two months, we had our first multi-service incident that required correlating what happened across the gateway, the Orders service, and the Payment service. The investigation took four hours. Each service used a different log format, none of them included a consistent request identifier, and there was no trace context linking the gateway's access log to the downstream service logs. We rebuilt the request timeline from timestamps and IP addresses.

We needed a consistent telemetry contract: every request that enters the gateway must produce a structured log entry with a request identifier, and that identifier must be propagated downstream so it appears in every service's logs for that request.

## Decision
The gateway enforces the following on every inbound request:

**Request ID:** If the request does not include an `X-Request-ID` header, the gateway generates a UUID v4 and sets it. The header is forwarded to every upstream service. Services must include this ID in their own log entries.

**Distributed trace context:** The gateway reads and propagates W3C Trace Context headers (`traceparent`, `tracestate`). If no traceparent is present, the gateway creates a new trace span. All upstream requests receive the propagated context.

**Structured access log:** Emitted for every request in JSON format with these fields: `request_id`, `trace_id`, `method`, `path`, `route_name`, `upstream_service`, `status_code`, `latency_ms`, `tenant_id`. No user-identifiable fields (no email, no IP address in production logs -- IP is hashed before storage to comply with our data retention policy).

All log fields are defined in a shared schema document. Services that add the `request_id` to their own logs without matching the schema will be flagged in code review.

## Alternatives Considered

**Each service generates and manages its own trace context:** Simple, no gateway dependency. Rejected because there is no way to correlate what happened at the edge (rate limit decisions, routing choices, auth failures) with what happened downstream without a shared trace ID injected by the gateway.

**OpenTelemetry collector as the centralized telemetry pipeline:** Push all traces and logs through an OTel collector rather than relying on the gateway's access log as the primary edge record. This is the long-term direction but requires each service to instrument with OTel SDKs. We kept the gateway access log as the minimum viable approach and will migrate to full OTel instrumentation per service over the next two quarters.

**Include client IP in access logs:** Useful for abuse detection. Rejected for standard logs because of GDPR constraints in EU regions. We hash the IP before storage for the specific purpose of abuse detection, keeping the raw IP only in a restricted security log with a 7-day retention policy.

## Consequences

### Positive
- Any incident involving an external request can be triaged by searching for the request ID across all service logs simultaneously
- Distributed traces link gateway decisions (which rate limit bucket was applied, which upstream was chosen) to downstream call behavior
- The shared log schema makes log-based SLO calculation (error rate, p99 latency at the edge) straightforward

### Negative
- Log volume increases proportionally with traffic; at 10,000 requests/second the access log generates roughly 2 GB/hour before compression
- Teams that do not propagate `X-Request-ID` in their service logs create gaps in the trace that make incidents harder to debug

### Risks
- **PII leaking into logs via custom headers.** Mitigation: the shared schema defines exactly which fields are logged; gateway middleware strips any non-schema headers from the logged request before writing the access log entry.

## Review Trigger
Revisit once OTel instrumentation covers all services, at which point the gateway access log can be retired in favor of a unified trace backend and the schema maintenance burden goes away.
