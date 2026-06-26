# Cost Analysis — Bulkhead Pattern

## Cost Drivers

Bulkheads add cost in ways that are easy to underestimate because the primary cost is not infrastructure — it is capacity headroom and engineering time.

| Dimension | Description |
|---|---|
| **Capacity headroom** | When a bulkhead rejects a request (fail-fast), that capacity is preserved for other callers. But the caller that was rejected needs to go somewhere — either fail to the user or be retried. To keep rejection rates acceptable, you need total system capacity to be higher than without bulkheads, because you can no longer fully utilize each dependency connection to 100% of the pool. |
| **Observability infrastructure** | Bulkhead saturation metrics, per-dependency permit counters, rejection rate alerts — these require dashboard and alerting infrastructure that has its own hosting cost. |
| **Engineering time: initial configuration** | Limit-sizing requires analysis of traffic patterns, load testing, and documentation. One engineer-week per service at initial adoption is a reasonable estimate. |
| **Engineering time: ongoing tuning** | Limits must be revisited as traffic grows. This is not a one-time cost. Estimate 2–4 hours per dependency per quarter for a well-instrumented service. |
| **Dedicated infrastructure (if using pod-level isolation)** | Infrastructure-level bulkheads (separate Kubernetes pods per dependency type) require additional compute resources beyond what is needed for software-level semaphore bulkheads. |

---

## Option Comparison by Implementation Approach

### Option A: No Bulkhead (Shared Pool — Baseline)

All outbound calls share a single connection pool. No per-dependency limits. Infrastructure cost is minimal; engineering overhead is minimal. This is the pre-incident configuration.

| Traffic tier | Compute | Risk exposure |
|---|---|---|
| Small (<1K req/sec) | Baseline | Moderate — a slow dependency can affect others, but traffic volume limits blast radius |
| Medium (10K req/sec) | Baseline | High — shared pool exhaustion becomes likely under any single dependency degradation |
| Large (100K+ req/sec) | Baseline | Critical — shared pool exhaustion is essentially guaranteed during any dependency incident |

**The hidden cost:** a single dependency incident causes total outage. At $X per hour of downtime, even one Black Friday-scale incident exceeds the full cost of implementing bulkheads for years.

### Option B: Semaphore-Based Bulkheads (Recommended)

A software semaphore per dependency limits concurrent in-flight requests. No additional infrastructure required. Works with async I/O. This is the approach adopted in ADR-002.

| Scale tier | Dependencies | Additional compute cost | Additional engineering cost | Total added cost/month |
|---|---|---|---|---|
| Small (<1K req/sec, 1–5 deps) | 4 | ~$0 (semaphores use negligible memory) | ~4 hrs/month tuning | ~$200–400 (engineer time) |
| Medium (10K req/sec, 5–15 deps) | 10 | ~$0 | ~8 hrs/month tuning | ~$400–800 (engineer time) |
| Large (100K+ req/sec, 15+ deps) | 20 | ~$0–50/month (metrics volume) | ~16 hrs/month tuning | ~$800–1,600 + observability |

The compute cost of semaphore-based bulkheads is negligible. Acquiring and releasing a semaphore permit is microseconds of CPU time. The only infrastructure cost increase is the additional metrics data volume from per-dependency permit counters and rejection rate gauges.

### Option C: Dedicated Thread Pools Per Dependency (Thread-Per-Request Runtimes Only)

For runtimes that use a thread-per-request model (some Java frameworks, PHP, Ruby), dedicated thread pools per dependency achieve the same isolation as semaphores but with actual OS threads. This approach was evaluated and rejected for the Order Processing service (async I/O runtime), per ADR-002.

| Scale tier | Additional compute cost | Notes |
|---|---|---|
| Small (4 deps, thread pools of 20 each) | +2–4 vCPUs worth of thread stack overhead | Each thread consumes ~512KB–1MB of stack; 80 total threads = ~80MB memory overhead |
| Medium (10 deps) | +5–10 vCPUs equivalent | Thread contention and context switch overhead begins to matter |
| Large (20 deps) | +$200–800/month in compute | Thread pools large enough for high traffic require meaningful compute; auto-scaling is harder |

Not recommended for async I/O services. Natural fit for synchronous thread-per-request services where the thread pool already exists.

### Option D: Infrastructure-Level Isolation (Separate Pods Per Dependency Type)

At the extreme end: route all calls to Payment through one set of pods, all calls to Inventory through another, and so on. Physical isolation prevents any shared resource consumption at the OS level.

| Scale tier | Additional compute cost | Notes |
|---|---|---|
| Small (4 deps) | +$300–600/month | 4 additional pod groups, each requiring minimum 2 replicas for HA |
| Medium (10 deps) | +$800–2,000/month | 10 pod groups; operational complexity increases significantly |
| Large (20 deps) | +$2,000–8,000/month | 20 pod groups; Kubernetes cluster size increases; justified only for strict compliance or high blast-radius reduction requirements |

Appropriate when regulatory requirements demand physical isolation (e.g., PCI payment processing separated from fraud analytics), or when a specific dependency's failure mode is severe enough to warrant complete resource separation. Not appropriate as the default approach — semaphore bulkheads achieve 90% of the isolation benefit at 1% of the cost.

---

## Hidden Costs

These costs are real but do not appear in cloud billing:

| Cost | Description | Estimate |
|---|---|---|
| **Over-provisioning from conservative limits** | Teams setting limits conservatively (lower than necessary) to be safe causes more rejections than needed, which requires retries, which increases effective load. To compensate, teams often over-provision compute. | +10–20% compute spend |
| **Engineering time for initial limit-sizing** | Traffic analysis, load testing, documentation. Not a recurring cost, but real at adoption. | 1 engineer-week per service |
| **Capacity planning complexity** | With bulkheads, unused capacity in one dependency's pool cannot be automatically borrowed by another. This makes capacity planning slightly more complex — you plan per-dependency rather than globally. | +2–4 hours/quarter per service |
| **Retry traffic overhead** | Rejected requests that are retried generate additional load. Without backoff and jitter, rejected requests become a retry storm that increases total request volume. | Variable; see cost anti-patterns |

---

## Cost Anti-Patterns

**1. Setting limits too high**

A bulkhead limit of 1,000 permits for a dependency that never has more than 30 concurrent in-flight requests at peak provides no meaningful isolation. If the dependency degrades and accumulates slow connections, 1,000 of them can still exhaust the service's connection infrastructure. The limit must be sized to the realistic maximum needed for the dependency, not to a number large enough that it will never trigger.

Setting limits too high defeats the purpose while still requiring the administrative overhead of having a limit.

**2. Setting limits too low**

A Payment service bulkhead set to 10 permits when peak concurrent payment calls reach 45 means 35 payment calls per second are being rejected during normal peak traffic — before any failure has occurred. This creates constant user-visible errors that cost revenue, and engineers spend time tuning the wrong variable (they increase compute rather than adjusting the limit).

**3. Not instrumenting limits**

A bulkhead limit that emits no metrics is invisible capacity waste. You do not know if the limit is ever being approached (too low, causing latency in permit acquisition), never being approached (too high, providing no protection), or being hit constantly (causing rejections you don't know about). Uninstrumented limits cannot be tuned.

**4. Running bulkheads in queuing mode instead of fail-fast mode**

Queuing-mode bulkheads (requests wait in a queue for a permit to become available rather than being rejected immediately) feel safer but accumulate cost without improving outcomes. A queue of 200 waiting requests each holding a connection consumes connection resources. The requests at the back of the queue will time out before they ever receive a permit. The queue adds latency to every rejection without reducing the rejection rate. Fail-fast is almost always the correct mode — per ADR-003.

**5. Using infrastructure-level isolation as the default**

Separate pods per dependency type costs $300–8,000+/month in additional compute depending on scale. Semaphore bulkheads cost $0 in additional infrastructure. Unless regulatory or physical isolation requirements apply, use semaphores.

---

## Cost by Decision Point

| Decision | Lower cost option | Higher cost option | When to choose higher |
|---|---|---|---|
| Semaphore vs. thread pool bulkheads | Semaphore (async runtimes) | Thread pool (synchronous runtimes) | Only when using thread-per-request runtime |
| Semaphore vs. pod-level isolation | Semaphore | Separate pods per dependency type | PCI physical isolation, high blast-radius dependencies |
| Fail-fast vs. queuing mode | Fail-fast | Queuing | Almost never — queuing adds cost with no meaningful benefit |
| Single shared limit vs. per-tenant limits | Single limit | Per-tenant limits | Multi-tenant systems where one tenant can starve others |
| Manual tuning vs. auto-sizing tooling | Manual tuning | Auto-sizing tooling | >10 dependencies, high-traffic services where manual review lags traffic growth |
