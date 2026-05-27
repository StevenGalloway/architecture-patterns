# ADR-005: Observability and runbooks for rate limits

## Status
Accepted

## Date
2026-02-25

## Context
Rate limiting has two failure modes that are operationally opposite: too permissive (allows abuse, backend services are overloaded) and too restrictive (blocks legitimate traffic, paying customers receive 429s).

In the first month after rate limiting was deployed, both failure modes occurred:

**Too permissive:** The token bucket configuration for the catalog endpoint had a refill rate of 100 tokens/second (set conservatively high during initial deployment to avoid false positives). A scraper found the effective rate and systematically stayed just under it, making 95 requests per second continuously. Backend catalog database costs increased by 40% over the month before the pattern was identified. The 429 rate metrics were near zero (the scraper was not hitting the limit), so there was no alert.

**Too restrictive:** A new mobile app release caused a burst of 70 requests per page load (the new feature was loading assets and API calls in parallel). The burst size configuration was 50 tokens (adequate for the previous app version's 30-request burst). The new version's 70-request burst triggered 429s on the last 20 requests of each page load. Customer complaints about broken features in the new app version took 6 hours to trace back to the rate limit configuration.

Both problems required operational visibility that was not in place at deployment time.

## Decision
The following metrics are instrumented for the rate limiting layer:

**429 rate metrics:**
- `ratelimit.rejected.count` per rule name (e.g., `catalog_ip`, `auth_api_key`), per HTTP status that triggered it
- `ratelimit.rejected.count` per API key (for daily quota violations)
- `ratelimit.rejected.count` per IP (for token bucket violations)
- Alert if any single API key is rejected more than 100 times in any 5-minute window (indicating either a quota exhaustion or a misconfigured client)

**Utilization metrics:**
- `ratelimit.utilization.pct` per rule: percentage of limit currently used (current tokens consumed / bucket capacity for token buckets; current count / daily quota for quotas)
- Alert if any rule's utilization exceeds 80% for more than 10 consecutive minutes (early warning for capacity review)
- Alert if utilization drops suddenly from high to zero (may indicate a quota reset or a client changing behavior)

**Redis health:**
- `ratelimit.redis.latency_ms` p99: latency for rate limit Redis operations
- `ratelimit.redis.errors.count`: Redis errors causing fail-open behavior
- Page if Redis error count exceeds 10 in any 1-minute window

**Backend protection validation:**
- `backend.catalog.rps` and `backend.auth.rps`: requests per second reaching backend services
- Alert if backend RPS exceeds 80% of the service's capacity threshold (indicates rate limits are not providing sufficient protection)

**Runbooks:**
1. How to raise a specific client's limit without affecting other clients (per-key override configuration)
2. How to identify and block an abusive API key or IP range (blacklist configuration + WAF escalation path)
3. How to safely adjust a rule's token bucket configuration (canary deployment: apply to 10% of gateway instances, verify 429 rate and backend load, then roll out to all instances)
4. How to handle a quota exhaustion complaint from a paying customer (emergency quota increase procedure, billing team escalation)
5. How to diagnose and resolve a Redis rate limit state inconsistency (key inspection commands, counter reset procedure)

## Alternatives Considered

**Alert only on 429 spikes for specific clients:** Monitor 429 rates for known high-value clients and alert when their 429 rate increases unexpectedly. Rejected as a primary strategy because the scraper abuse case (too permissive) would not generate 429 spikes -- the scraper stayed under the limit. Utilization metrics that detect sustained high usage are needed to catch that pattern.

**Automated limit adjustment (self-healing rate limits):** Automatically increase limits for API keys that are consistently hitting them, and decrease limits for keys with zero utilization. Rejected because automated limit changes without human review can produce unexpected side effects (a scraper that consistently hits the limit would have its limit raised, increasing its access to backend services).

**Business-level impact metrics instead of infrastructure metrics:** Monitor backend service health (latency, error rate) and backtrack from degradation to rate limit configuration. Rejected because the sequence is backwards: by the time backend degradation is visible, the rate limit failure has already had impact. Rate limit metrics provide leading indicators before backend impact.

## Consequences

### Positive
- The scraper-under-limit scenario would have been detected within 10 minutes by the catalog utilization alert (sustained 95% utilization of the catalog token bucket) rather than discovered through a monthly cost review
- The mobile app burst scenario would have been detected by the 429 rate per-rule alert within minutes of the app release
- The canary deployment runbook for limit changes provides a safe, documented process for configuration updates that prevents the "changed a limit and caused unexpected behavior" incident pattern

### Negative
- Per-API-key and per-IP 429 tracking creates high-cardinality metrics if the number of unique API keys and IPs is large; the metrics platform must be capable of handling this cardinality
- The utilization alert threshold (80%) may trigger during legitimate traffic spikes (e.g., a product launch) that temporarily drive up utilization without indicating abuse

### Risks
- **False positive utilization alerts during planned traffic events.** A marketing campaign that drives 10x normal catalog traffic will trigger the utilization alert legitimately but not require action (the rate limits are working as intended). Mitigation: the runbook documents how to suppress alerts during planned high-traffic events, and the alert includes context (which rule, which time window) to help distinguish planned spikes from unexpected load.

## Review Trigger
Revisit alert thresholds quarterly or after any planned high-traffic event that triggers false positive alerts. Revisit the per-API-key 429 tracking if the number of API keys grows to a scale that creates metrics cardinality problems.
