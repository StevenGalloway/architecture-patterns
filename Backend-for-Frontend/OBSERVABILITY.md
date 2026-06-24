# Observability — Backend-for-Frontend Pattern

## Why the BFF Requires Its Own Observability Layer

The BFF occupies a unique position in the observability stack. It is the last service a client request touches before the domain service layer, and the first service to assemble and return a response the user actually sees. This means:

- **BFF latency is UX latency.** When the BFF is slow, the user's screen is blank. There is no layer between BFF and client that can absorb the delay.
- **BFF partial responses are a first-class metric.** A BFF that returns a degraded response because one upstream failed is doing the right thing — but a high partial response rate signals a domain service problem that is silently degrading user experience.
- **The BFF introduces a fanout multiplier.** One request to the BFF generates 5–8 downstream calls. Observability must account for this: a spike in BFF traffic is a 5–8× spike in domain service traffic.
- **There is one BFF per client type.** Metrics must be sliced by client type to distinguish mobile degradation from web degradation. A p95 latency spike on the mobile BFF is invisible if metrics are aggregated across all BFFs.

---

## Golden Signals

### 1. Latency

The BFF has three distinct latency contributors that must be measured independently to diagnose the root cause of any latency regression.

| Metric | Description | Alert threshold |
|---|---|---|
| `bff.endpoint_latency_ms` (by client type, by endpoint) | End-to-end time from request receipt to response sent. This is the UX-facing metric — the number the user experiences. | p95 > 500ms for mobile; p95 > 800ms for web |
| `bff.upstream_latency_ms` (by domain service) | Time spent waiting for each individual domain service call to return. Measured per domain service, not aggregated. | p95 > domain service's own p95 SLO × 1.5 |
| `bff.composition_overhead_ms` | `endpoint_latency_ms` minus the maximum of all `upstream_latency_ms` values (the slowest upstream call). This is the time the BFF spent in its own code: response projection, cache writes, serialization. | p95 > 50ms |

The composition overhead metric isolates BFF-layer performance from domain service performance. If `endpoint_latency_ms` is high but `composition_overhead_ms` is low, the problem is upstream. If `composition_overhead_ms` is high, the problem is in the BFF's own aggregation or projection logic.

**Parallel call latency interpretation:** Because the BFF calls domain services in parallel, `endpoint_latency_ms` is bounded by the slowest upstream call, not the sum. If Profile takes 80ms, Catalog takes 120ms, and Recommendations takes 95ms, `bff.upstream_latency_ms{service="catalog"}` is 120ms and `endpoint_latency_ms` is approximately 120ms + composition overhead. An alert on Catalog latency identifies the specific upstream causing UX degradation.

### 2. Traffic

| Metric | Description |
|---|---|
| `bff.requests_per_second` (by client type, by endpoint) | Request rate per BFF and per endpoint. Baseline this per time-of-day; mobile traffic has a sharper peak than web. |
| `bff.upstream_fanout_ratio` (by endpoint) | Number of domain service calls made per BFF request, averaged per endpoint. Should be a stable, bounded number. A fanout ratio that is increasing over time indicates composition logic is accumulating upstream calls without review. |
| `bff.cache_hit_rate` (by endpoint) | Percentage of BFF requests served from cache without upstream calls. Alert when this drops significantly below baseline — indicates cache invalidation, cache eviction pressure, or upstream response schema change that invalidates cache keys. |
| `bff.ai_cache_hit_rate` (by endpoint, for AI-enabled endpoints) | Separate metric for AI response cache hit rate. Lower than standard cache hit rate is expected (AI responses are more user-specific), but a sudden drop indicates a cache key issue. |

### 3. Errors

Distinguish errors by source: errors the BFF generates itself versus errors propagated from upstream services.

| Error class | Metric | Meaning |
|---|---|---|
| **Auth failures** | `bff.errors{type="auth", status=401}` | JWT invalid, expired, or missing. Rate spike indicates a client token refresh issue or an auth library regression. |
| **Validation failures** | `bff.errors{type="validation", status=400}` | BFF-layer input validation rejected the request. Usually client SDK bug. |
| **Partial responses** | `bff.partial_response_rate` (by endpoint) | BFF returned a degraded response because one or more upstream calls failed or timed out. This is NOT an error — it is the correct fallback behavior. But a rising rate indicates domain service degradation that is silently affecting user experience. |
| **Full failures** | `bff.errors{type="composition_failure", status=500}` | BFF composition logic threw an uncaught exception or all upstream calls failed. This is a BFF outage for that endpoint. |
| **Upstream errors** | `bff.upstream_errors{service="orders", status=5xx}` | Domain service returned a 5xx. BFF handles this by serving a partial response or fallback, but the error is still tracked per upstream service. |
| **Client errors by client type** | `bff.client_error_rate{client_type="mobile"}` | Error rate as experienced by mobile users vs. web users. A mobile-specific spike indicates a mobile BFF regression that does not affect web. |

**Partial response rate is a primary SLI**, not a secondary metric. A BFF with a 10% partial response rate means 10% of users are seeing a degraded home screen. This warrants an alert even though no 5xx errors are returned.

### 4. Saturation

The BFF's saturation model is different from a standard web service because of its parallel upstream call pattern.

| Metric | Description | Alert threshold |
|---|---|---|
| `bff.upstream_concurrent_calls` (by domain service) | Total number of in-flight calls to each upstream service across all BFF request handlers. The BFF makes N parallel calls per request, so this can be N× the BFF's request concurrency. | > 80% of connection pool limit per service |
| `bff.cache_memory_utilization` | Redis memory usage as percentage of provisioned capacity. | > 75% |
| `bff.connection_pool_utilization` (by domain service) | Connection pool to each domain service: used connections / total pool size. | > 80% |
| `bff.cpu_utilization` | CPU across BFF instances. JSON serialization and response projection are CPU-bound at high throughput. | > 65% sustained |
| `bff.cache_eviction_rate` | Number of cache entries evicted before TTL expiry due to memory pressure. A rising eviction rate means the cache is undersized for the workload. | > 5% of entries/minute |

---

## SLI / SLO Definitions

### Client-Perceived Latency SLO

**SLI:** Percentage of requests where `bff.endpoint_latency_ms` is under the threshold, measured per endpoint per client type.

**SLO:** 95% of mobile BFF home screen requests complete in under 400ms. 95% of web BFF home screen requests complete in under 600ms.

Endpoints are not aggregated. A slow search endpoint does not pollute the home screen latency SLO. Set per-endpoint thresholds based on UX requirements for that specific screen.

### Partial Response Rate SLO

**SLI:** Percentage of BFF requests that return a fully hydrated response (all upstream calls succeeded).

**SLO:** Partial response rate under 2% over any 1-hour window per endpoint.

A partial response rate above 2% means more than 1 in 50 users is seeing a degraded screen. This should trigger investigation of the upstream service contributing most to partial responses.

### Availability SLO

**SLI:** Percentage of BFF requests that return any response (full or partial) with status 200–499, measured per client type.

**SLO:** 99.9% availability per BFF per calendar month.

Note: partial responses count as available. A BFF that always degrades gracefully is meeting its availability SLO even if domain services are partially down. Full failures (5xx, timeouts, no response) count against availability.

---

## Structured Log Schema

Every BFF request produces one structured log entry. Domain service calls are summarized within the entry, not as separate log lines.

```json
{
  "timestamp": "2025-11-26T14:23:01.482Z",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "client_type": "mobile",
  "bff_name": "mobile-bff",
  "method": "GET",
  "endpoint": "/mobile/home",
  "status_code": 200,
  "total_latency_ms": 312,
  "composition_overhead_ms": 18,
  "cache_hit": false,
  "partial_response": false,
  "auth_result": "success",
  "user_id_hash": "a7f3b2c9...",
  "upstream_calls": [
    { "service": "profile-service",         "latency_ms": 45,  "status": 200, "cache_hit": true },
    { "service": "catalog-service",         "latency_ms": 290, "status": 200, "cache_hit": false },
    { "service": "recommendations-service", "latency_ms": 180, "status": 200, "cache_hit": false },
    { "service": "orders-service",          "latency_ms": 95,  "status": 200, "cache_hit": false }
  ],
  "upstream_fanout": 4,
  "response_size_bytes": 1842
}
```

**Explicitly excluded:** response body content, user email, full user ID in plaintext (hashed for correlation), IP address in plaintext (hashed), any PII fields from domain service responses.

The `upstream_calls` array provides a per-request attribution of latency to specific domain services. When the Catalog service latency spikes, this field makes it immediately visible in log queries without requiring a separate distributed trace lookup for routine diagnosis.

---

## Key Dashboards

### 1. BFF Health Dashboard (operational, always-on)

One dashboard instance per BFF, parameterized by `bff_name`:

- Endpoint latency p50/p95/p99 by endpoint (last 1 hour)
- Partial response rate by endpoint (last 1 hour)
- Upstream latency p95 by domain service (last 1 hour — isolates which upstream is causing UX issues)
- Cache hit rate by endpoint (last 1 hour)
- Active upstream connection pool utilization per service

### 2. Cross-BFF Comparison Dashboard (platform team, weekly review)

- Side-by-side p95 latency comparison across all BFFs (same endpoint where applicable)
- Fanout ratio trend per BFF (rising fanout indicates composition accumulation)
- Shared library version adoption across BFFs (which BFFs are behind on auth middleware version)
- Partial response rate comparison across BFFs for same upstream service (e.g., all BFFs calling Orders — if mobile BFF has 5% partial rate and web BFF has 0.5%, the mobile BFF's circuit breaker configuration may differ)

### 3. UX Impact Dashboard (product team, daily review)

- Mobile home screen load time SLO compliance (% of requests under 400ms)
- Web home screen load time SLO compliance
- Partial response rate as "degraded experience rate" (product-friendly label)
- Cache hit rate as "server efficiency" (tracks whether BFF is reducing domain load)

---

## Chaos Engineering Test Scenarios

Run these in staging before go-live and quarterly thereafter:

| Scenario | Method | Expected BFF behavior | Pass criteria |
|---|---|---|---|
| **One domain service completely down** | Kill the Recommendations service container | BFF returns partial response: home screen renders without recommendations section; `partial_response: true` in log | 100% of requests return 200 with `partial_response: true`; no 5xx; partial response rate metric increases as expected |
| **All domain services are slow** | Inject 2000ms latency on all domain services | BFF reaches configured timeout (e.g., 1500ms); returns partial responses based on whichever calls completed within timeout | BFF returns within `timeout + composition_overhead`; `partial_response: true` for all calls that did not complete; no connection pool exhaustion |
| **BFF cache is empty (cold start)** | Flush Redis cache; replay production traffic | All requests miss cache; full fanout to all domain services; latency increases to uncached baseline | Domain services handle the traffic spike without exceeding their own SLOs; BFF latency stays under uncached SLO threshold; cache warms up within 5 minutes |
| **Domain service schema change** | Modify Catalog service to rename a field the BFF projection depends on | BFF composition throws on missing field | BFF logs a composition error for the affected field; partial response served without the affected field; alert fires; domain service Pact contract test fails and catches this pre-production |
| **Auth middleware library update** | Upgrade auth library to a new version in one BFF | JWT validation behavior changes per new library version | Existing valid tokens continue to be accepted; new revocation behavior (if any) works correctly; no false 401s on valid tokens |
| **Traffic spike (5× normal)** | Load test at 5× baseline | BFF autoscaling triggers; connection pools to domain services are not exhausted; cache absorbs a significant fraction of increased load | p95 latency stays within SLO during scale-out; connection pool utilization stays under 80%; partial response rate does not increase (spike is absorbed by scale and cache) |

---

## Alerting Philosophy

**Page on (immediate on-call response required):**
- `bff.endpoint_latency_ms` p95 > SLO threshold for 5 consecutive minutes (by client type)
- `bff.partial_response_rate` > 5% for 5 consecutive minutes on any endpoint (domain service degradation affecting users at scale)
- BFF process availability below 99% for 5 minutes (deployment failure, crash loop)
- Connection pool to any domain service at > 95% utilization for 3 minutes (impending cascade)

**Notify (Slack or ticket; no page):**
- `bff.partial_response_rate` between 2% and 5% for 15+ minutes (investigate root upstream)
- `bff.cache_hit_rate` drops more than 20 percentage points from baseline for 30 minutes (cache invalidation event or eviction pressure)
- `bff.upstream_fanout_ratio` increases more than 15% from weekly baseline (composition is accumulating upstream calls)
- Any BFF running on an auth middleware library version more than 90 days old (security patch compliance)
- `bff.composition_overhead_ms` p95 exceeds 100ms (BFF's own code is becoming a latency contributor)

**Do not alert on:**
- Individual upstream errors (alert on rates, not individual failures)
- Cache misses during cache warm-up after a deployment (normal behavior; expected for first 5 minutes)
- Partial responses during known domain service maintenance windows (suppress alert based on maintenance window schedule)
