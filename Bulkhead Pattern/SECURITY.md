# Security Architecture — Bulkhead Pattern

## Threat Model

The Bulkhead pattern is fundamentally a resource isolation mechanism. Its security relevance is primarily in availability: it prevents one resource consumer from starving others. But it also introduces its own attack surface — the configuration of limits and the behavior under saturation — and in multi-tenant systems, bulkhead scope (per-system vs. per-tenant) is a critical security boundary.

### Attack Surface Overview

```
Inbound traffic → Bulkhead Manager → Downstream Dependency
                        ↑
              (resource allocation policy)
              
Attacker targets: the allocation policy itself (misconfiguration),
                  or uses traffic to exhaust permits for legitimate callers.
```

| Attack Surface | Threat | Severity |
|---|---|---|
| **DoS via permit exhaustion** | Attacker sends traffic that targets a specific dependency, exhausting its bulkhead permits and triggering rejections for all legitimate callers to that dependency | High |
| **Noisy neighbor exploitation** | In multi-tenant systems, one tenant's high traffic consumes a shared bulkhead's permits, degrading service for all other tenants | High |
| **Bulkhead misconfiguration** | Incorrect limits (too high or missing for a dependency) allow a non-critical service to consume critical-path capacity, reproducing the original Black Friday incident as an exploitable condition | High |
| **Retry storm amplification** | Retry logic without awareness of bulkhead state sends retries into an already-exhausted bulkhead, amplifying load and prolonging saturation | Medium |
| **Circuit breaker manipulation** | Attacker sends traffic patterns that repeatedly trip and reset circuit breakers for a dependency, keeping the service in a degraded state and increasing permit acquisition wait time | Medium |
| **Queue poisoning** | In queuing-mode bulkheads, a slow request at the front of the queue delays all requests behind it regardless of priority; an attacker can craft requests specifically designed to be slow and hold queue position | Medium |
| **Configuration store tampering** | Unauthorized modification of bulkhead limit configuration (via compromised CI/CD pipeline, misconfigured secrets management, or insider threat) allows limits to be zeroed out, blocking all calls to a dependency | Medium |
| **Observability blind spot exploitation** | Attacker identifies uninstrumented bulkheads (no rejection metrics) and targets those dependencies, knowing the operations team will not detect the saturation | Low |

---

## Threat 1: Denial of Service via Permit Exhaustion

An attacker with enough traffic — or with access to a single high-volume client — can exhaust the permit pool for a specific dependency by sending requests that acquire permits and hold them for a long time (slow requests).

**Example attack pattern:**
1. Attacker identifies that the Fraud Detection bulkhead has 30 permits.
2. Attacker sends 30 requests that trigger slow fraud checks (large order amounts, new accounts, suspicious patterns that trigger deeper analysis).
3. All 30 permits are held by attacker-controlled requests.
4. Legitimate fraud checks for real orders are rejected for the duration of the slow requests.
5. Orders that require synchronous fraud checks cannot complete.

**Controls:**

| Control | Description |
|---|---|
| Per-request timeouts (ADR-004) | Each in-flight request is subject to a timeout. A slow request held by an attacker will be cancelled at timeout, releasing its permit. Timeout must be set short enough that permit exhaustion is temporary, not sustained. |
| Rate limiting at inbound boundary | Upstream rate limiting (API gateway or load balancer) limits total inbound requests per client per second, constraining how quickly an attacker can exhaust permits even if individual requests are fast. |
| Permit acquisition timeout | Fail-fast mode: a request that cannot acquire a permit immediately is rejected, not queued. This prevents an attacker from forcing other callers into an indefinitely-growing queue. |
| Authentication before permit acquisition | Unauthenticated requests are rejected before reaching the bulkhead. An attacker must have valid credentials, which raises the bar for the attack and enables attribution. |

---

## Threat 2: Noisy Neighbor Exploitation (Multi-Tenant Systems)

In a multi-tenant deployment where multiple customers share the same Order Processing service, a single tenant with high traffic can exhaust a shared bulkhead's permits, causing rejections for all other tenants.

This is qualitatively different from general DoS: the attacker does not need to exceed the system's total capacity — they only need to exceed one bulkhead's permit count. If all tenants share a Fraud Detection bulkhead of 30 permits, a single tenant generating 30+ concurrent fraud checks starves every other tenant, even if overall system capacity is not under pressure.

**Mitigation: per-tenant bulkhead limits**

Per-tenant limits carve the permit pool per tenant:

```
Global Fraud Detection capacity: 30 permits
  → Tenant A: max 10 concurrent fraud checks
  → Tenant B: max 10 concurrent fraud checks
  → Tenant C: max 10 concurrent fraud checks
```

A single tenant can now consume at most 10 permits, leaving capacity for others. The tradeoff: unused permits in one tenant's allocation cannot be automatically borrowed by another (static partitioning), which reduces utilization efficiency. Dynamic per-tenant limits with a global ceiling address this but require more complex implementation.

Per-tenant limits are required in multi-tenant systems where tenants represent different organizations (not different users within the same organization). For single-organization multi-user systems, per-tenant limits are optional; per-user limits are rarely necessary.

---

## Threat 3: Bulkhead Misconfiguration

The original Black Friday incident was a security-relevant availability failure caused by misconfiguration: no isolation between dependencies meant Fraud Detection consumed all shared capacity. Misconfiguration of bulkhead limits can recreate this condition even after bulkheads are adopted.

**High-risk misconfigurations:**

| Misconfiguration | Effect |
|---|---|
| Setting a non-critical dependency limit equal to or higher than a critical dependency limit | Non-critical dependency can consume capacity that critical-path callers need; reproduces the incident |
| Setting a limit to unlimited (or very high) for a "temporary" exception that becomes permanent | Effective elimination of the bulkhead for that dependency |
| Failing to configure a bulkhead for a new dependency added to the service | New dependency operates with implicit unlimited capacity; becomes the next incident |

**Controls:**
- CI validation that every downstream dependency in the service's dependency list has a corresponding bulkhead configuration entry
- Policy check that non-critical dependencies have limits lower than critical-path dependencies
- Required metadata fields (rationale, review date, owner) that fail CI if missing

---

## Threat 4: Retry Storm Amplification

When a bulkhead is exhausted and begins rejecting requests, the caller must decide what to do. If the caller's retry policy retries immediately on rejection, the retry arrives immediately, also finds the bulkhead exhausted, and is also rejected. Multiply this by hundreds of concurrent callers and the retry volume significantly exceeds the original request volume, worsening the saturation condition rather than allowing recovery.

This is not an external attacker scenario — it is an emergent failure mode caused by the interaction of bulkhead rejection with retry logic. But it can be exploited: an attacker who understands the retry behavior can trigger a small initial saturation and then watch the retry storm amplify it without further attacker action.

**Controls:**

| Control | Description |
|---|---|
| Bulkhead-aware retry policy | Before retrying, check whether the bulkhead's permit availability is above a minimum threshold. If the bulkhead is still exhausted, do not retry immediately. |
| Exponential backoff with jitter on bulkhead rejection | Treat bulkhead rejection like a 429 response: back off exponentially with random jitter. This spreads retry traffic over time and allows the bulkhead to recover. |
| Retry budget per request | Limit the total number of retries per original request. A request rejected by a bulkhead 3 times in a row is failed, not retried indefinitely. |
| Circuit breaker companion | After N consecutive bulkhead rejections to a dependency, open the circuit breaker. Stops all calls to the dependency for the recovery window, allowing permits to drain and the dependency to stabilize. |

---

## Threat 5: Queue Poisoning (Queuing Mode)

If the bulkhead is configured in queuing mode (requests wait in a queue rather than being immediately rejected when permits are exhausted), a slow request at the front of the queue blocks all requests behind it regardless of their priority or type.

An attacker who can control the content of requests can craft requests specifically designed to be slow-processing at the downstream dependency, hold queue position, and delay all legitimate requests queued behind them.

**Mitigation:** Use fail-fast mode, not queuing mode (ADR-003). Fail-fast eliminates queue poisoning by eliminating the queue. When queuing is required for legitimate reasons (e.g., background job processing), use priority queues with separate queues per priority class, so a low-priority slow request cannot block high-priority requests.

---

## Compliance Relevance

| Standard | Bulkhead's role |
|---|---|
| **SOC 2 CC9.1** | Risk mitigation controls. Bulkheads demonstrate that the organization has implemented controls to prevent a single component failure from causing system-wide unavailability. Provides evidence that cascading failure risk is managed. |
| **SOC 2 Availability** | Bulkheads are a direct availability control. In a SOC 2 availability audit, the ability to demonstrate that Fraud Detection degradation cannot affect Payment processing is evidence of isolation controls that protect service availability commitments. |
| **PCI DSS Req 6.4 (Availability)** | Payment processing capacity must be protected. PCI assessors reviewing a service that shares compute between payment processing and non-payment workloads will look for evidence of isolation. Semaphore bulkheads with a dedicated payment limit (80 permits, critical path) provide this evidence in a software-observable way. |
| **PCI DSS Req 12.3.1 (Capacity)** | Organizations must ensure adequate capacity for critical systems. Bulkhead limits sized and documented for payment processing, with review dates and monitoring, directly satisfy this requirement. |
| **ISO 27001 A.17.2** | Availability of information processing facilities. Bulkheads are a technical control that supports this objective. The documented configuration, monitoring, and review process provides the audit trail ISO 27001 assessors expect. |

---

## Security Review Checklist

Before any bulkhead configuration change reaches production:

- [ ] Every downstream dependency has a configured bulkhead limit (no implicit unlimited dependencies)
- [ ] Critical-path dependencies (Payment, Inventory) have higher limits than non-critical dependencies (Fraud Detection, Notification)
- [ ] Fail-fast mode is configured (not queuing mode) unless there is a documented business reason for queuing
- [ ] Per-request timeouts are configured for every dependency covered by a bulkhead (see ADR-004)
- [ ] Circuit breaker is configured alongside bulkhead for each dependency (complementary controls)
- [ ] Retry policy checks bulkhead state before retrying and uses exponential backoff on rejection
- [ ] Multi-tenant deployments use per-tenant limits, not shared limits across tenant boundaries
- [ ] Bulkhead rejection events emit metrics with dependency label (required for DoS detection)
- [ ] Alert is configured on rejection rate exceeding normal baseline (saturation early warning)
- [ ] Configuration store (YAML/config file) is version-controlled and changes require peer review
