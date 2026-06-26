# AI Integration — Bulkhead Pattern

## Why AI Workloads Make Bulkheads Mandatory

AI workloads violate every assumption that makes shared resource pools safe. A typical REST API call takes 5–50ms and consumes negligible compute. An LLM inference call takes 500ms–30 seconds and consumes GPU memory, CPU, and connection slots for its entire duration. A single LLM inference batch job can consume the equivalent of 500 transactional API calls' worth of resources.

Without bulkheads, the Black Friday incident — where Fraud Detection consumed all shared connections and took down order processing — plays out continuously in systems that mix AI workloads with transactional workloads. The AI workload is the new Fraud Detection: non-critical (from the transactional service's perspective), resource-intensive, and capable of starving every other dependency if left unbounded.

---

## 1. GPU/CPU Pool Isolation

LLM inference is compute-intensive in a way that has no precedent in traditional API workloads. A single inference request on a capable model can hold a GPU thread for seconds and consume gigabytes of GPU VRAM for the duration of the request. Without isolation, inference workloads and transactional workloads compete for the same compute.

The failure mode is identical to the original incident:

| Original incident | AI workload equivalent |
|---|---|
| Fraud Detection: slow database queries consuming shared connection pool | LLM inference: GPU-intensive requests consuming shared compute thread pool |
| 160 of 200 shared connections consumed by Fraud Detection | AI inference batch job consuming 80% of shared CPU/GPU capacity |
| Inventory and Payment calls fail for lack of connections | Order processing and payment authorization fail for lack of compute |
| 100% order failure including customers with no fraud risk | 100% transactional failure including requests that never touch AI features |
| Mitigation: dedicated semaphore of 30 permits for Fraud Detection | Mitigation: dedicated compute pool for AI inference, isolated from transactional compute |

**Implementation approaches:**

```
Option A: Semaphore-based (software-level)
  transactional_pool: 120 concurrent requests (order creation, payment, inventory)
  ai_inference_pool:   20 concurrent requests (recommendations, fraud ML, content gen)

Option B: Pod-level isolation (infrastructure-level)
  transactional-pods (n=4): Handle all non-AI workloads
  inference-pods     (n=2): Handle all AI inference, GPU-attached
```

Software-level semaphores are sufficient when AI inference runs on the same compute as transactional workloads. Pod-level isolation is required when AI workloads need GPU nodes that are separate from CPU nodes by necessity — which is typically the case for any serious LLM deployment.

**Node affinity in Kubernetes:**

```yaml
# AI inference pods: GPU nodes only
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: node.kubernetes.io/instance-type
              operator: In
              values: ["g4dn.xlarge", "g4dn.2xlarge"]

# Transactional pods: CPU nodes only (cannot schedule on GPU nodes)
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: node.kubernetes.io/instance-type
              operator: NotIn
              values: ["g4dn.xlarge", "g4dn.2xlarge"]
```

This is the infrastructure-level bulkhead: a GPU saturation event cannot consume CPU-node resources, and CPU scaling events do not affect GPU node availability for inference.

---

## 2. Inference Queue Bulkheads: Interactive vs. Batch

AI systems typically serve two request classes with incompatible latency requirements:

- **Interactive inference:** Real-time chat, user-facing recommendations, on-demand classification. Latency SLO: < 500ms to first token, < 3s total. If a user waits more than 3 seconds for a response, they leave.
- **Batch inference:** Async document processing, background content generation, nightly model evaluation jobs. Latency SLO: complete within minutes to hours. Individual request latency is irrelevant.

Without separate queues and separate consumers, an interactive request queues behind 500 batch jobs. The interactive user waits for batch jobs to complete before their request is even picked up.

**Separate queues with dedicated consumers:**

```
Interactive Queue  ─► 4 inference workers  (low latency, always available)
Batch Queue        ─► 2 inference workers  (high throughput, may be pre-empted)

When interactive queue depth > 0: interactive workers are never stolen for batch.
When interactive queue is empty: batch workers can run at full capacity.
```

This is the AI-specific form of separate dependency bulkheads. Just as the Order Processing service gives Payment a dedicated 80-permit semaphore that Fraud Detection cannot touch, the inference service gives interactive requests a dedicated pool of workers that batch jobs cannot consume.

**Configuration:**

```yaml
inference_bulkheads:
  interactive:
    max_concurrent: 4
    queue_depth: 10        # Fail-fast after 10 queued; reject rather than queue indefinitely
    timeout_ms: 5000
    priority: high
    rationale: "User-facing requests. Latency SLO: 3s. Must not queue behind batch."
    review_date: 2026-01-01

  batch:
    max_concurrent: 2
    queue_depth: 500       # Large queue acceptable; jobs are async and can wait
    timeout_ms: 300000     # 5 minute timeout per batch job
    priority: low
    rationale: "Background jobs. Throughput over latency. Pre-emptible when interactive demand rises."
    review_date: 2026-01-01
```

---

## 3. Token Budget Bulkheads

Traditional bulkheads isolate at the connection or thread level. AI workloads need bulkheads at the **token budget level** — because the cost and latency of an LLM call is determined by token count, not by request count.

A single request processing a 100,000-token document can consume as much compute and API budget as 500 requests each processing 200-token classification tasks. Request-level semaphores alone do not capture this: 30 concurrent 100K-token requests exhaust an API provider's rate limit orders of magnitude faster than 30 concurrent 200-token requests.

**Token budget isolation by request type:**

```
Request type          Token budget (input)  Token budget (output)  Max concurrent
─────────────────────────────────────────────────────────────────────────────────
Short classification  200 tokens            50 tokens              50 concurrent
Standard chat         4,000 tokens          1,000 tokens           20 concurrent
Long document         100,000 tokens        5,000 tokens           2 concurrent
```

The long-document bulkhead limits to 2 concurrent requests. This is not because the service can't handle more — it's because 3 simultaneous 100,000-token requests would exhaust the API provider's token-per-minute rate limit for all other request types.

**Multi-tenant token budget bulkheads:**

One tenant submitting a large batch of 100K-token documents should not exhaust the token rate limit pool for all other tenants. Per-tenant token budgets work the same way as per-tenant connection limits:

```
Global token budget: 500,000 input tokens/minute
  → Tenant A: max 100,000 tokens/minute
  → Tenant B: max 100,000 tokens/minute
  → Tenant C: max 100,000 tokens/minute
  → Reserved:  200,000 tokens/minute (internal, ops, burst headroom)
```

A tenant submitting a large batch hits their 100,000 token/minute ceiling. Other tenants' interactive requests continue without degradation.

---

## 4. Fallback Model Bulkheads

When the primary model's bulkhead is exhausted — high traffic has consumed all 20 concurrent inference permits for the GPT-4 or Claude Opus pool — the choice is between rejecting the request and routing to a fallback model.

This is the AI-specific form of the graceful degradation that bulkheads enable: not just "fail fast," but "fail to the next best available resource."

**Bulkhead hierarchy with fallback routing:**

```
Request arrives → Check primary model bulkhead (Claude Opus, 20 permits)
                       │
               ┌───────┴────────┐
         permit available    bulkhead exhausted
               │                    │
         Call primary          Check fallback bulkhead (Claude Haiku, 50 permits)
         model (Opus)               │
                            ┌───────┴────────┐
                      permit available    both exhausted
                            │                    │
                      Call fallback          Reject request
                      model (Haiku)         with 503 + Retry-After
```

**When to use a fallback model:**
- Interactive requests: always route to fallback rather than reject. A slightly lower quality response is better than no response.
- Batch requests: reject and requeue. Do not consume fallback model capacity on work that can wait.
- Classification tasks: fallback model is equally capable; no quality degradation.
- Complex reasoning tasks: document the quality tradeoff; accept the fallback only if the latency SLO is more important than the quality.

**Observability for fallback routing:**

```
ai.inference.primary_model_used{model="opus"}         # Primary model calls
ai.inference.fallback_model_used{model="haiku"}       # Fallback model calls
ai.inference.fallback_rate                            # % of requests hitting fallback
ai.inference.primary_bulkhead_utilization_pct         # Primary pool saturation
```

A rising fallback rate signals that the primary model's bulkhead is being approached and primary capacity should be reviewed.

---

## Mapping Bulkhead ADRs to AI Workloads

| Existing decision | AI workload implication |
|---|---|
| **ADR-001**: Dedicated semaphore per dependency | AI workloads are a new dependency class. Each AI model provider (OpenAI, Anthropic, Bedrock) and each model tier (Opus, Sonnet, Haiku) should have its own semaphore. Mixing them in a shared pool recreates the pre-bulkhead problem. |
| **ADR-002**: Semaphore-based limits for async I/O | Most AI inference clients are async-native. Semaphore-based limits are the correct choice, exactly as for the transactional dependencies. Token budget limits require additional instrumentation beyond connection counts. |
| **ADR-003**: Fail-fast, not queuing | For interactive AI requests, fail-fast is correct: queue a maximum of 10 requests, then reject. For batch AI requests, deep queues are acceptable because the caller expects async behavior. Use different bulkhead configurations per request class. |
| **ADR-004**: Per-request timeouts | AI inference timeouts must account for streaming: the timeout clock starts from request initiation, not from first token receipt. A request that receives its first token at 2s and then stalls must be cancelled at the total timeout, not the first-token timeout. |
| **ADR-005**: Observability and tuning | AI bulkheads require additional metrics: token count per request (not just request count), model latency by model tier, fallback activation rate, cost per permitted request. Standard request-rate metrics are insufficient. |
