# Observability — API Gateway Pattern

## Why Observability Matters More at the Gateway

Every request that enters your system passes through the gateway. This makes the gateway's observability layer the most valuable single source of truth in your stack:

- **It sees 100% of external traffic**, including traffic that fails before reaching any service
- **It can correlate across services** via request IDs and trace context it injects
- **Its failure modes are silent without instrumentation** — a misconfigured rate limit silently drops legitimate traffic; a routing regression returns 502s that look like service failures

Getting gateway observability right reduces mean time to detection (MTTD) and mean time to resolution (MTTR) for the class of incidents most likely to affect all users simultaneously.

---

## Golden Signals

The four golden signals applied to the API Gateway:

### 1. Latency

| Metric | What to measure | Alert threshold |
|---|---|---|
| `gateway.latency.p50` | Median request latency (gateway processing only, excluding upstream) | Baseline × 2 |
| `gateway.latency.p95` | 95th percentile end-to-end latency (including upstream) | > 500ms |
| `gateway.latency.p99` | 99th percentile end-to-end latency | > 2000ms |
| `gateway.upstream_latency.p95` | Time spent waiting for upstream response, by service | Per-service baseline × 3 |
| `gateway.processing_overhead` | `total_latency - upstream_latency` | > 20ms |

The delta between `total_latency` and `upstream_latency` is the gateway's own processing time. If this grows, the gateway itself is the problem (CPU saturation, JWKS fetch delays, Redis rate limit store latency).

### 2. Traffic

| Metric | What to measure |
|---|---|
| `gateway.requests.rate` | Total requests/second, by route and upstream service |
| `gateway.requests.by_tenant` | Requests/second per tenant — spikes indicate abuse or misconfigured clients |
| `gateway.requests.by_method` | GET/POST/PUT/DELETE breakdown — unexpected shifts indicate integration issues |
| `gateway.auth.failures.rate` | 401s per second — sustained increase indicates credential issue or attack |
| `gateway.rate_limited.rate` | 429s per second — spike indicates a client in a retry storm |

### 3. Errors

Distinguish gateway-generated errors from upstream errors:

| Status | Source | Meaning |
|---|---|---|
| 401 | Gateway | JWT invalid, expired, or missing |
| 403 | Gateway | Authenticated but route not permitted for this client type |
| 429 | Gateway | Rate limit exceeded |
| 502 | Gateway | Upstream service unreachable or returned invalid response |
| 504 | Gateway | Upstream service did not respond within timeout |
| 5xx from upstream | Upstream | Service-level failure, forwarded by gateway |

```
gateway.errors.rate{status="401"}  → auth failures
gateway.errors.rate{status="429"}  → rate limiting
gateway.errors.rate{status="502"}  → upstream connectivity
gateway.errors.rate{status="5xx", source="upstream"}  → service failures
```

Alert when 502/504 rate > 0.1% of total requests — this means a service is down or degraded.

### 4. Saturation

| Metric | What to measure | Alert threshold |
|---|---|---|
| `gateway.cpu.utilization` | CPU % across gateway instances | > 70% sustained |
| `gateway.memory.utilization` | Memory % across gateway instances | > 80% |
| `gateway.connections.active` | Open connections (critical for streaming/SSE workloads) | > 80% of connection limit |
| `gateway.rate_limit_store.latency` | Redis latency for rate limit check | > 5ms p99 |
| `gateway.jwks_cache.miss_rate` | JWKS cache misses (should be near zero between rotations) | > 1% |

---

## SLI / SLO Definitions

### Availability SLO

**SLI:** Percentage of requests that receive a non-502/503/504 response within 5 seconds.

```
SLI = (requests resulting in {200-499} OR {502-504 with latency < 5000ms}) / total_requests
```

**SLO:** 99.9% over a rolling 28-day window.

Error budget: 99.9% = 43.8 minutes downtime/month.

### Latency SLO

**SLI:** Percentage of requests where end-to-end latency (client → gateway → upstream → gateway → client) is under 1000ms.

**SLO:** 95% of requests complete in under 1000ms.

### Authentication SLO

**SLI:** Percentage of requests with valid JWTs that receive a non-401 response from the gateway.

**SLO:** 99.99% (false positives on valid token rejection are unacceptable — they lock out real users).

---

## Structured Access Log Schema

Every request produces one access log entry. Fields:

```json
{
  "timestamp": "2025-11-26T14:23:01.482Z",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "method": "POST",
  "path": "/api/v1/orders",
  "route_name": "orders-v1",
  "upstream_service": "orders-service",
  "upstream_latency_ms": 142,
  "total_latency_ms": 148,
  "status_code": 201,
  "tenant_id": "tenant_abc123",
  "client_type": "mobile",
  "rate_limit_remaining": 847,
  "auth_result": "success",
  "cache_hit": false
}
```

**Explicitly excluded:** email addresses, IP addresses in plaintext (hash for abuse detection only), request bodies, response bodies, authorization header values.

---

## Key Dashboards

### 1. Gateway Health Dashboard (operational, always-on)
- Request rate by route (last 1 hour)
- Error rate by status code (last 1 hour)
- P95 latency by upstream service (last 1 hour)
- Active connections vs. connection limit
- Rate of 429s (rate limit exhaustion)

### 2. Tenant Usage Dashboard (business, daily review)
- Top 10 tenants by request volume
- Tenants approaching rate limit thresholds
- Cost attribution by tenant (if billing by API usage)

### 3. Security Dashboard (security team, reviewed weekly)
- Auth failure rate over time (401s per hour)
- Unusual traffic patterns (tenant volume spikes > 3σ)
- WAF block rate
- Geographic distribution of requests (anomaly detection)

### 4. SLO Burn Rate Dashboard (on-call, 24/7)
- Availability SLO burn rate (current window vs. budget)
- Latency SLO compliance
- Error budget remaining (28-day window)

---

## Chaos Engineering Test Scenarios

Run these in staging before going to production and on a quarterly cadence thereafter:

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Upstream service down** | Kill one upstream service container | Gateway returns 502 for affected routes; other routes unaffected | 100% of unaffected route requests succeed; 502 logged with `upstream_service` label |
| **Upstream service slow** | Inject 3000ms latency on upstream | Gateway times out at configured `timeout_ms`; returns 504 | P99 latency stays within 2× timeout config; no connection exhaustion |
| **JWT signing key rotated** | Rotate JWKS key; send requests with old token | Gateway serves valid requests until token `exp`; rejects after expiry | No false 401s during rotation overlap window |
| **Rate limit store unavailable** | Kill Redis | Gateway should fail open (allow requests) or fail closed (block) per configured policy | Documented behavior matches actual behavior; no silent data loss |
| **Traffic spike (10× normal)** | Load test at 10× baseline | Autoscaling triggers; gateway latency stays within SLO | P95 latency < 500ms; no 503s during scale-out |
| **Malformed JWT flood** | Send 10,000 requests with invalid JWTs | Gateway returns 401s quickly; does not degrade valid traffic | Valid traffic P99 latency unaffected; 401s logged but not alerting on-call |
| **Config deployment** | Deploy a route config change | Zero requests dropped during config reload | 0 502s or 504s during deployment; 0 requests routed to wrong upstream |

---

## Alerting Philosophy

**Page on:**
- Availability SLO burn rate: burning more than 5% of monthly error budget in 1 hour
- Gateway 502/504 rate: > 1% for 5 consecutive minutes (upstream connectivity problem)
- Gateway process CPU: > 80% for 10 consecutive minutes (capacity problem)
- Auth failure rate: > 50× baseline for 5 minutes (potential credential stuffing attack)

**Notify (no page):**
- Any tenant's request rate exceeds 80% of their rate limit tier for 15+ minutes
- JWKS cache miss rate > 0.5% (may indicate key rotation issue)
- P95 latency > 300ms for 15+ minutes (approaching SLO boundary)
- Gateway config deployment completes (audit trail, not an alert)

**Do not alert on:**
- Occasional 429s (expected behavior under rate limiting)
- Individual 401s (expected behavior; alert only on rate, not individual occurrences)
- Gateway restart events (alert only if unavailability exceeds 30 seconds)
