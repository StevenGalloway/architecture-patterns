# ADR-005: Define timeouts, retry budgets, and runbooks for stuck sagas

## Status
Accepted

## Date
2026-03-11

## Context
Distributed workflows can hang indefinitely. A participant service may be down, a message may be stuck in a queue, or a compensation may silently fail. Without explicit timeout and retry policies, sagas can sit in an intermediate state for hours before anyone notices. We have seen this in similar systems: a webhook notification service that stopped responding caused thousands of orders to remain in a `PAYMENT_OK` state for six hours because nothing was checking for progress.

We need a policy that defines when to give up on a step, what to do when retries are exhausted, and how on-call engineers diagnose and recover stuck sagas. This is operational infrastructure, not just code.

## Decision
**Per-step timeouts:** Each saga step has a 30-second timeout measured from when the command is published to when the orchestrator expects a result event. If no event arrives within 30 seconds, the orchestrator retries the command.

**Retry budget:** The orchestrator retries each step up to three times with exponential backoff: 5s, 15s, 45s. After three failures, the saga transitions to `FAILED` (forward path) or `COMPENSATION_FAILED` (during compensation) and emits an alert.

**Stuck saga detection:** A background goroutine scans the saga state store every 5 minutes and emits a `saga.stuck` metric for any saga that has not progressed in over 15 minutes. An alert fires when this count is non-zero. The 15-minute threshold was chosen to avoid false positives from legitimate slow participant responses under load.

**Operational metrics emitted:**
- `saga.started`, `saga.completed`, `saga.failed`, `saga.compensation_started`, `saga.compensation_failed`
- `saga.step.duration_ms` per step name
- `saga.stuck.count` (from the background scanner)

**Runbook:** The runbook for a stuck saga in `FAILED` state instructs on-call to: (1) read the saga record to identify the last successful step, (2) verify the participant service is healthy, (3) manually trigger compensation via the admin API endpoint, or (4) mark the saga as manually resolved if compensation cannot run.

## Alternatives Considered

**Saga-level timeout only (no per-step timeout):** A single deadline for the entire saga. Simpler to implement but harder to act on -- if a saga hits its deadline, we do not know which step it was stuck on. Per-step timeouts give better diagnostic granularity for on-call.

**Dead-letter queue as the primary detection mechanism:** Rely on the DLQ growing as the signal that something is stuck, rather than active scanning. Rejected because not all stuck sagas result in DLQ messages -- a saga waiting for an event that never arrives produces no DLQ entry, just silence.

**External saga orchestration platform (Temporal):** Would provide built-in timeout handling, retry policies, and a UI for inspecting stuck workflows. Rejected for this implementation because of the operational overhead of running Temporal for a single workflow type. Noted in ADR-001 as the recommendation if workflow count grows.

## Consequences

### Positive
- Every stuck saga produces an alert within 20 minutes of becoming stuck (15-minute threshold plus scrape interval)
- The retry budget is deterministic: any step that fails will exhaust retries and move to FAILED within 95 seconds worst case (5 + 15 + 45 + 30-second final timeout)
- On-call has a documented runbook rather than having to improvise

### Negative
- The 30-second per-step timeout may be too tight if Shipping's external carrier API has high latency; we may need to tune this per-step rather than using a global value
- The background scanner adds complexity to the orchestrator and needs its own tests
- Manual resolution paths in the runbook require on-call to have direct access to the saga state store, which has security implications

### Risks
- **Alert fatigue if thresholds are miscalibrated.** Mitigation: run the background scanner for two weeks in metric-only mode (no alert) before enabling the alert, and use the observed p99 progress interval to set the threshold.

## Review Trigger
Revisit the 30-second step timeout if participant SLAs change. Also revisit the entire retry strategy if we add a step that calls an external third-party API with unpredictable latency; a flat timeout may not be appropriate there.
