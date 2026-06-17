# Observability — Anti-Corruption Layer Pattern

## Why Observability Matters More at the ACL

The Anti-Corruption Layer is, by design, a silent translator. When it works, nothing is visible — vendor data enters, canonical domain data exits, and consumers see nothing of the translation. This invisibility is exactly why observability at the ACL is critical: when translation fails silently (a field maps to null instead of erroring, a cached stale response is served, a vendor schema drifts past the validator), nothing breaks loudly. The domain accumulates corrupted data without any explicit signal.

The ACL is also the sole point of contact with the vendor. Every vendor latency spike, rate limit hit, and contract violation is filtered through the ACL. Without instrumentation here, the domain team has no view of vendor health and no ability to distinguish "our system is slow" from "the vendor is slow."

Getting ACL observability right reduces mean time to detection (MTTD) for the class of incident that is hardest to find: silent data quality degradation that accumulates over days before manifesting in user-facing errors.

---

## Golden Signals

The four golden signals applied to the ACL:

### 1. Latency

| Metric | What to measure | Alert threshold |
|---|---|---|
| `acl.vendor_call.latency.p50` | Median latency of outbound vendor API calls, by vendor | Baseline × 2 |
| `acl.vendor_call.latency.p95` | 95th percentile vendor call latency | > 500ms |
| `acl.vendor_call.latency.p99` | 99th percentile vendor call latency | > 2,000ms |
| `acl.translation.latency.p95` | Time spent in translation logic (excluding vendor call) | > 10ms (should be near-zero) |
| `acl.cache.latency.p99` | Cache read latency for cached vendor responses | > 5ms |

The delta between `acl.vendor_call.latency` and `acl.translation.latency` is the vendor's contribution to total ACL latency. If translation latency grows unexpectedly, it signals a schema complexity spike (new vendor field requiring expensive processing) or a regression in translation logic.

### 2. Traffic

| Metric | What to measure |
|---|---|
| `acl.vendor_call.rate` | Total vendor API calls per second, by vendor and endpoint |
| `acl.cache.hit_rate` | Cache hit percentage for vendor responses — a drop signals TTL expiry misconfiguration or a new request pattern |
| `acl.translation.rate` | Total translations per second — should track closely with `acl.vendor_call.rate` minus cache hits |
| `acl.circuit_breaker.state` | Current circuit breaker state per vendor (closed / open / half-open) |
| `acl.vendor_call.retry.rate` | Retry rate per vendor — a spike signals vendor instability |

### 3. Errors

The ACL has three distinct error surfaces that must be measured separately:

| Error surface | Metric | Meaning |
|---|---|---|
| **Vendor errors** | `acl.vendor_call.error.rate{type="http_5xx"}` | Vendor is failing. Check circuit breaker status. |
| **Schema validation failures** | `acl.validation.failure.rate` | Vendor schema has drifted from expected contract. Requires immediate human review. |
| **Translation errors** | `acl.translation.error.rate` | Bug in translation logic or unexpected field state. |
| **Circuit breaker trips** | `acl.circuit_breaker.open.rate` | Vendor is consistently failing; ACL has stopped calling it. |
| **Cache stale serves** | `acl.cache.stale_serve.rate` | ACL served cached data beyond TTL due to vendor unavailability. |

Schema validation failure rate is the most important metric the ACL emits. A non-zero rate means the vendor has changed their API without notice. Zero tolerance: any validation failure should trigger a notification within 5 minutes.

```
acl.validation.failure.rate > 0 for any 5-minute window → PagerDuty notification
acl.circuit_breaker.state == 'open' for > 2 minutes → PagerDuty page
acl.vendor_call.error.rate{type="http_5xx"} > 5% for 5 minutes → Slack alert
```

### 4. Saturation

| Metric | What to measure | Alert threshold |
|---|---|---|
| `acl.vendor_call.concurrent` | Current concurrent in-flight vendor calls | > 80% of configured connection pool |
| `acl.circuit_breaker.half_open.duration` | Time spent in half-open state | > 30 seconds (vendor not recovering) |
| `acl.rate_limit.remaining` | Vendor API rate limit headroom (if vendor exposes it) | < 20% remaining |
| `acl.cache.memory.utilization` | Cache memory utilization | > 80% |

---

## SLI / SLO Definitions

### Translation Availability SLO

**SLI:** Percentage of consumer requests to the ACL that receive a valid canonical response (either from vendor call or cache) within 1,000ms.

```
SLI = successful_canonical_responses / total_consumer_requests
```

**SLO:** 99.5% over a rolling 28-day window.

Note: 99.5% rather than 99.9% because the ACL is dependent on vendor availability. A 99.5% SLO acknowledges that vendor outages are outside the ACL team's control, while still setting a meaningful availability target that accounts for circuit breaker recovery time.

Error budget: 99.5% = 3.6 hours downtime/month.

### Schema Validity SLO

**SLI:** Percentage of vendor API responses that pass schema validation without modification or error.

**SLO:** 99.9% over a rolling 28-day window.

A schema validation failure rate above 0.1% indicates a vendor API drift that has not been caught by contract tests. This SLO is a canary for contract test coverage gaps.

### Translation Latency SLO

**SLI:** Percentage of translation operations that complete in under 50ms (excluding vendor call latency).

**SLO:** 99% of translations complete in under 50ms.

Translation logic is pure computation — if it exceeds 50ms, something is wrong (inefficient mapping logic, synchronous I/O inside translation, schema validator running on oversized payloads).

---

## Structured Log Schema

Every vendor call produces one structured log entry:

```json
{
  "timestamp": "2025-11-26T14:23:01.482Z",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "vendor": "crm-vendor-acme",
  "vendor_endpoint": "/api/v3/customers/{id}",
  "vendor_api_version": "v3",
  "consumer_service": "customer-domain-service",
  "cache_hit": false,
  "vendor_latency_ms": 142,
  "translation_latency_ms": 3,
  "validation_result": "passed",
  "canonical_entity_type": "CanonicalCustomer",
  "circuit_breaker_state": "closed",
  "status": "success"
}
```

Schema validation failures add:
```json
{
  "validation_result": "failed",
  "validation_errors": ["field 'account_status' expected string, received number"],
  "raw_vendor_field_names": ["id", "account_status", "display_name"],
  "status": "validation_error"
}
```

**Explicitly excluded from logs:** vendor field values that contain PII (`email_address`, `full_name`, `date_of_birth`), raw API keys, request/response bodies except in structured validation error form, canonical field values that contain PII.

---

## Key Dashboards

### 1. ACL Health Dashboard (operational, always-on)

- Vendor call rate by vendor and endpoint (last 1 hour)
- Vendor call error rate by error type (last 1 hour)
- Cache hit rate by vendor (last 1 hour)
- Circuit breaker state by vendor (last 24 hours)
- Schema validation failure rate (last 24 hours — zero is the expected value)

### 2. Translation Quality Dashboard (data engineering, daily review)

- Schema validation failures by vendor, with validation error detail
- Translation error rate by canonical entity type
- Vendor API version distribution (what percentage of calls hit v1 vs. v2 vs. v3)
- Fields that were null in translation output (diagnostic for silent mapping bugs)

### 3. Vendor Health Dashboard (vendor relationship, weekly review)

- Vendor latency trends over 30 days
- Vendor error rate over 30 days
- Rate limit consumption over 30 days
- Circuit breaker trips over 30 days (this is the SLA discussion input for vendor reviews)

### 4. SLO Burn Rate Dashboard (on-call, 24/7)

- Translation availability SLO burn rate (current window vs. budget)
- Schema validity SLO compliance
- Error budget remaining (28-day window)

---

## Chaos Engineering Test Scenarios

Run these in staging before going to production and on a quarterly cadence thereafter:

| Scenario | Method | Expected behavior | Pass criteria |
|---|---|---|---|
| **Vendor API returns 500** | Mock vendor to return 5xx for 60 seconds | ACL circuit breaker opens; consumers receive cached data or error response | Circuit breaker opens within 5 failed calls; zero schema corruption in read models |
| **Vendor API changes field type** | Inject response with `account_status: 1` instead of `account_status: "active"` | Schema validation fails; ACL rejects payload and returns error to consumer | Validation failure logged with field detail; consumer receives error (not corrupted canonical data) |
| **Vendor API adds unknown field** | Inject response with new field `regulatory_classification: "restricted"` | ACL allowlist drops unknown field silently; consumer receives canonical response without the new field | No error logged; no new field in canonical output; `validation_result: "passed"` |
| **Vendor API is slow (3s latency)** | Inject 3,000ms response latency | ACL timeout triggers; circuit breaker trips after threshold; consumers served from cache | Timeout metric emitted; circuit breaker opens; cached data served until vendor recovers |
| **Cache unavailable** | Kill Redis cache for 5 minutes | ACL falls back to direct vendor calls; latency increases; error rate from cache layer logged | Consumer requests continue to succeed (slower); zero data loss; cache recovery automatic |
| **Security-relevant field goes null** | Inject vendor response with `account_status: null` | Strict schema validation rejects null for `account_status`; consumer receives error | No null value reaches canonical model; consumer receives validation error, not null canonical status |
| **Vendor credential rotation** | Rotate vendor API key while traffic is live | ACL detects 401 from vendor; retrieves new key from Secrets Manager; resumes calls | Zero calls fail after credential rotation except during the brief re-fetch window (< 30 seconds) |

---

## Alerting Philosophy

**Page on:**
- Any circuit breaker opens for more than 2 minutes (vendor is down)
- Translation availability SLO burning more than 5% of monthly budget in 1 hour
- Schema validation failure rate > 0 for more than 5 minutes (vendor schema drift)
- ACL process CPU > 80% sustained for 10 minutes (unexpected compute spike in translation logic)

**Notify (no page):**
- Vendor call latency p95 > 500ms for 15 minutes (approaching SLO boundary)
- Cache hit rate drops below 50% (TTL or traffic pattern change)
- Vendor rate limit headroom below 30% (approaching vendor throttle)
- Circuit breaker in half-open state for more than 30 seconds (vendor not recovering cleanly)

**Do not alert on:**
- Individual vendor 4xx responses (expected behavior — vendor handles occasional not-found)
- Cache misses after a deployment (cache warming is expected behavior)
- Validation warnings on informational fields (only alert on strict-validation failures for security-relevant fields)
