# Observability: Feature Flags and Remote Configuration

## Overview

Flag observability has a different character from application observability. Flag evaluation itself is in-process and sub-millisecond — there is no network call to time out, no external service to fail. The observability focus is on the *system around* flag evaluation: Is the SDK cache fresh? Are flag changes propagating to all instances within SLO? Is the variant distribution matching the targeting rules? Is flag governance debt accumulating?

The four golden signals apply, but their meaning is flag-specific.

---

## Four Golden Signals

### 1. Latency

| Metric | Alert Threshold | Notes |
|--------|----------------|-------|
| `flags.evaluation.latency.p99` | > 2ms | In-process evaluation should be sub-millisecond. A p99 > 2ms indicates a cache problem — the SDK is falling back to a blocking refresh call, which should never happen in normal operation. |
| `flags.sdk.sync.latency.seconds` | SLO: < 5s; alert > 30s | Time from flag change written to management API to confirmation that all connected SDK instances have received the update via SSE. This is the most important propagation SLO. A kill switch that takes 30 seconds to propagate is a kill switch you cannot rely on during an incident. |
| `flags.management_api.latency.p95` | > 500ms | Management API is a low-traffic control plane. p95 > 500ms indicates infrastructure saturation or a database query problem. SDK clients are not affected (in-process cache), but engineers creating/modifying flags will notice. |

---

### 2. Traffic

| Metric | Alert Condition | Notes |
|--------|----------------|-------|
| `flags.evaluations.rate` by `flagKey`, `variant` | No alert threshold; use for investigation | Total evaluations per second per flag and variant. Baseline this on day one — traffic drops to a flag that should be serving requests indicate a code bug (flag key renamed, wrong key in application code). |
| `flags.variant.distribution` | Alert on shift > 20% relative change in 5 minutes | Percentage of evaluations returning each variant, by flag. A release flag configured for 10% rollout that suddenly shows 100% assignment is a targeting rule misconfiguration. A flag that drops from 100% to 0% without a management API write is an evaluation error or an SDK cache issue. |
| `flags.sdk.connections.active` | Alert on drop > 10% from baseline in 5 minutes | Number of connected SDK instances with active SSE connections. A sudden drop indicates an SSE infrastructure failure or a deployment event (normal to drop briefly during rolling restart; abnormal to drop and not recover). |
| `flags.kill_switch.activations.total` | Alert on every activation (count > last value) | Every kill switch flag state change should trigger an alert to the on-call channel. Kill switch activations are operational events, not silent configuration changes. |

---

### 3. Errors

| Metric | Alert Condition | Notes |
|--------|----------------|-------|
| `flags.evaluation.errors.rate` by `errorType` | Alert on first occurrence of `flag-not-found` | `flag-not-found` is a code bug: the application is evaluating a flag key that does not exist in the flag system. This should never happen in production if flag keys are validated at deploy time. Other error types (schema mismatch, evaluation timeout) alert at > 0.1% rate. |
| `flags.schema.validation.failures.rate` | Alert on > 0/minute sustained for 5 minutes | Invalid flag values rejected at write time. This indicates an integration problem (a CI/CD pipeline or automation tool submitting malformed flag updates). Should normally be zero. |
| `flags.sdk.cache.staleness.seconds` | Alert > 60s | Age of the in-process SDK cache since last SSE push confirmation. Staleness > 60s means the SSE connection has likely dropped and the SDK is not receiving updates. Kill switch changes will not propagate to this instance. |
| `flags.management_api.errors.rate` | Alert > 1% sustained for 3 minutes | Management API 5xx rate. Does not affect flag evaluation (in-process cache), but prevents flag creation, modification, and kill switch activation. |

---

### 4. Saturation

| Metric | Alert Condition | Notes |
|--------|----------------|-------|
| SSE connection count vs. server capacity | Alert at 80% of configured max connections per SSE server | Each SSE server instance has a file descriptor limit and connection capacity ceiling. At 80%, scale out SSE infrastructure before hitting the ceiling. |
| Redis cache memory utilization | Alert at 75% | Flag state is stored in Redis for SSE broadcasting. At 75% utilization, flag state cache is approaching eviction risk. Eviction of flag state causes all SDK instances to fall back to safe defaults on next SSE push. |
| Audit log storage growth rate | Alert if monthly growth > 2× previous month baseline | Sudden audit log growth spikes indicate either a high-volume automation tool making many flag changes (review the audit log for suspicious activity) or a runaway CI pipeline. |
| `flags.stale.count` by `team` | Alert if > 0 | Count of flags whose age exceeds their type TTL (Release flags > 30 days, Experiment flags > 90 days). Any non-zero value represents governance debt. Alert fires to the owning team's channel, not the platform team's channel. |

---

## SLO Summary

| SLO | Target | Measurement Window |
|-----|--------|-------------------|
| Flag evaluation latency p99 | ≤ 1ms | Rolling 5-minute window |
| SSE propagation latency p95 | ≤ 5 seconds | Per flag change event |
| Management API availability | 99.9% | Monthly |
| Management API latency p95 | ≤ 200ms | Rolling 5-minute window |
| Stale flag count | 0 (no stale flags) | Daily |
| Audit log immutability | 100% | Continuous verification |

---

## Structured Evaluation Event

Emit one event per flag evaluation, sampled at appropriate rates. Sampling strategy:

| Flag type | Sample rate | Rationale |
|-----------|------------|-----------|
| Ops / Kill Switch | 100% | Every activation matters; volume is low |
| Permission | 1% | High volume per user, low variance once assigned |
| Experiment | 10% | Statistical analysis requires sufficient sample; 10% of evaluations is usually adequate |
| Release | 1% | Volume control; used for error alerting, not statistical analysis |

**Event schema:**

```json
{
  "eventType": "flag.evaluation",
  "flagKey": "checkout.new-payment-flow",
  "variant": "enabled",
  "ruleMatched": "tenant-rule",
  "tenantId": "tenant_4f8b2c1d",
  "userId": "usr_9a3e7b2f",
  "sdkVersion": "2.4.1",
  "sdkLanguage": "node",
  "serviceId": "checkout-service",
  "serviceInstanceId": "pod-abc123",
  "timestamp": "2026-06-14T18:42:03.221Z",
  "cacheAgeMs": 847,
  "evaluationDurationMicros": 23
}
```

Note: `userId` is an opaque identifier — never an email address, name, or other PII. `cacheAgeMs` is the age of the in-process cache at evaluation time, enabling SDK staleness tracking without a separate probe.

---

## Kill Switch Propagation Dashboard

Kill switch activation is a time-critical operation. The observability layer must provide real-time visibility into propagation progress:

**Required dashboard view during kill switch activation:**

```
Kill Switch: checkout.payment-processor-v2
Activated at: 2026-06-14 18:42:03 UTC
Operator: alice@example.com
Target state: disabled → enabled (kill switch engaged)

SDK Instance Propagation:
  Total connected instances: 47
  Received update: 45 (95.7%)    [████████████████████░] 
  Pending:          2 (4.3%)
  Elapsed: 3.2s / 5.0s SLO

Variant Distribution (last 60s):
  enabled:  ████████░░░░░░░░░░░░  38%  (down from 100%)
  disabled: ░░░░░░░░████████████  62%  (and rising)
```

This view must be available during incidents, not require dashboard setup. It is part of the platform's default observability, not a custom investigation tool.

---

## Chaos Scenarios and Validation Tests

Run these scenarios quarterly in staging and during annual incident response drills.

### Scenario 1: Management API Unavailability

**Setup:** Shut down all management API instances. Maintain load on application services that evaluate flags.

**Expected behavior:**
- Flag evaluations continue using in-process SDK cache — no evaluation errors
- New flag changes cannot be written (management API 5xx)
- `flags.sdk.cache.staleness.seconds` metric increases monotonically from the moment the SSE connection drops
- Staleness alert fires at the 60-second threshold for all affected SDK instances

**Pass criteria:**
- Zero `flags.evaluation.errors.rate` during the outage window
- `flags.management_api.errors.rate` shows 100% 5xx for the outage duration
- Staleness alert fires within 65 seconds of SSE connection drop (alert threshold + 5s propagation)
- After API recovery: SSE reconnects within 30s; SDK cache updates within 5s of reconnect

---

### Scenario 2: SSE Infrastructure Failure (Management API Up, SSE Down)

**Setup:** Block network connectivity between SSE push service and SDK instances. Management API remains accessible.

**Expected behavior:**
- Flag evaluations continue using last-known-good cache — no evaluation errors
- New flag changes written to management API are queued for SSE delivery
- `flags.sdk.connections.active` drops to 0 within the SSE heartbeat timeout
- `flags.sdk.cache.staleness.seconds` begins increasing
- Upon SSE recovery: all queued changes deliver; SDK cache updates within SSE propagation SLO

**Pass criteria:**
- Zero evaluation errors during SSE outage
- Connection count alert fires within 30s of SSE failure
- After SSE recovery: all queued flag changes deliver within 5s of reconnect

---

### Scenario 3: Kill Switch Activation Under Load

**Setup:** System under production-equivalent load. Activate a kill switch for a flag currently serving the `enabled` variant to 100% of traffic.

**Expected behavior:**
- All 47 SDK instances receive the kill switch update within the 5-second SSE SLO
- Variant distribution for the killed flag transitions from 100% enabled → 100% disabled within the SLO window
- Kill switch activation alert fires in the on-call channel within 30 seconds

**Pass criteria:**
- 95th percentile propagation time ≤ 5 seconds (all but 5% of instances update within 5s)
- 100th percentile propagation time ≤ 30 seconds (all instances updated within 30s)
- Variant distribution reaches 100% disabled within 35 seconds of activation
- Zero evaluation errors during the propagation window

---

### Scenario 4: Percentage Rollout Statistical Validation

**Setup:** Create a release flag with 50% percentage rollout. Generate 10,000 evaluations with unique user IDs.

**Expected behavior:**
- Variant distribution for the flag is 48–52% (within a ±2% statistical tolerance band at 10,000 samples)
- Same user ID consistently receives the same variant across all evaluations (sticky hashing)
- Variant assignment does not change when the evaluation sequence is repeated

**Pass criteria:**
- Distribution is 48–52% over 10,000 unique users
- 100% of repeated evaluations for the same user return the same variant
- Distribution does not change between run 1 and run 2 with the same user set (determinism)
