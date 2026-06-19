# AI Integration — API Gateway Pattern

## The API Gateway as an LLM Gateway

The API Gateway pattern is the direct architectural ancestor of the **LLM Gateway** — a pattern that is now a foundational component in any enterprise AI platform. The same problems that drove adoption of API gateways for microservices (inconsistent auth, no rate limiting, no observability) reappear when teams start calling LLM APIs directly from services.

Without an LLM Gateway: every team integrates their own OpenAI/Anthropic/Bedrock client, implements their own retry logic, manages their own API keys, and has no visibility into aggregate spend or abuse. This is exactly the pre-gateway microservices problem.

---

## Where the Pattern Extends for AI Workloads

### 1. Token-Budget Rate Limiting (replaces request-count rate limiting)

Traditional rate limiting counts requests. LLM rate limiting must count **tokens**, because a single request can consume 1 token or 128,000 tokens, making request-count limits meaningless for cost control.

```
Traditional gateway:  limit = 100 requests/minute per tenant
LLM gateway:          limit = 500,000 input tokens/minute per tenant
                             + 100,000 output tokens/minute per tenant
```

Implementation: the gateway must inspect the response body (or stream) to count output tokens, or use model-reported usage fields. This is a fundamentally different rate-limiting architecture — the cost of a request is only fully known after it completes.

### 2. Model Routing (extends service routing)

Just as a traditional gateway routes `/orders` to the Orders service, an LLM gateway routes requests to different models based on:

| Routing dimension | Example |
|---|---|
| **Cost tier** | Simple classification tasks → Haiku; complex reasoning → Opus |
| **Tenant tier** | Free-tier users → small model; paid users → large model |
| **Task type** | Code generation → specialized code model; summarization → general model |
| **Latency SLO** | Real-time chat → fastest available model; async batch → cheapest model |
| **Fallback** | Primary model unavailable → fallback to secondary model |

This is model-aware routing logic that belongs at the gateway layer, not scattered across calling services.

### 3. Semantic Caching (new capability, not in traditional gateway)

LLM responses are expensive (~$0.015–$0.075 per 1K output tokens for capable models). Semantically similar questions should return cached answers.

Traditional gateway caching: exact URL + body match.
LLM gateway caching: embed the prompt, compare against cached prompt embeddings using cosine similarity, return cached response if similarity > threshold (typically 0.95+).

```
Request: "What is the capital of France?"
Cache hit: "What's France's capital city?"  → similarity 0.97 → return cached "Paris"
Cache miss: "Describe the history of Paris" → similarity 0.61 → call model
```

Cache storage: vector database (Pinecone, pgvector, Weaviate) alongside the traditional Redis cache.

### 4. Prompt Injection as an Attack Surface (new threat class)

Traditional gateways block SQL injection, XSS, path traversal. LLM gateways must additionally defend against **prompt injection**: user-supplied input that attempts to override system prompts or exfiltrate information.

Gateway-layer mitigations:
- Input scanning: pattern match against known prompt injection signatures ("ignore previous instructions", "you are now", "DAN mode")
- Output scanning: block responses that contain system prompt content, PII, or off-topic material
- Prompt envelope enforcement: gateway wraps user input in a structured envelope that the model is instructed to treat as user turn only — it cannot be interpreted as system instructions

Note: gateway-layer scanning is a defense-in-depth measure, not a complete solution. Prompt injection defense also requires model-side system prompt design. Neither layer alone is sufficient.

### 5. AI-Specific Observability (extends standard gateway observability)

Standard gateway metrics (latency, 5xx rate, request count) are necessary but insufficient.

Additional metrics required for LLM gateway:

| Metric | Why it matters |
|---|---|
| Input tokens per request | Cost driver; anomalous spikes indicate prompt stuffing attacks |
| Output tokens per request | Cost driver; correlates with response quality |
| Cost per request / per tenant | Enables chargeback and budget enforcement |
| Cache hit rate | Direct cost reduction metric |
| Model fallback rate | Indicates upstream model reliability |
| Refusal rate | Model safety guardrail effectiveness |
| Time to first token (TTFT) | User-perceived latency for streaming responses |
| Token generation rate (tokens/second) | Throughput metric for streaming |

### 6. Streaming Response Handling

Traditional gateways buffer complete responses before forwarding. LLM responses via Server-Sent Events (SSE) or streaming APIs must be forwarded progressively — users see tokens as they generate rather than waiting for the complete response.

This changes the gateway's connection model:
- Connections must stay open for the duration of model generation (seconds to minutes)
- Connection count per gateway instance is bounded differently than throughput
- Timeout configuration must account for long-running streams, not just request-response latency
- Circuit breaker logic must handle partial stream failures gracefully

---

## Architectural Patterns for LLM Gateway

### Pattern A: Sidecar to Existing Gateway

Add LLM-specific middleware to the existing API gateway. Simple, low overhead, works at small scale. Breaks down when token-level rate limiting and semantic caching add complexity that pollutes the general-purpose gateway.

### Pattern B: Dedicated LLM Gateway (Recommended for Enterprise)

A separate gateway process specifically for AI endpoints, sitting alongside the existing API gateway.

```
                          ┌─── API Gateway ───► Internal services
Client → WAF → Edge ─────┤
                          └─── LLM Gateway ──► Model APIs (OpenAI, Anthropic, Bedrock)
                                      │
                                      ├─► Semantic cache (pgvector / Pinecone)
                                      ├─► Token budget store (Redis)
                                      └─► AI observability (cost, tokens, safety)
```

Benefits: independent scaling, separate operational surface, model-specific optimizations without polluting general-purpose gateway config.

Reference implementations: LiteLLM (OSS), Portkey, Helicone, AWS Bedrock Guardrails (managed).

---

## Mapping Existing Gateway ADRs to AI Workloads

| Existing decision | AI workload implication |
|---|---|
| **ADR-001**: Thin gateway | LLM gateway needs more logic (token counting, semantic cache) than a traditional gateway. A "thin" LLM gateway is the wrong goal. The question is: is this logic *gateway-appropriate* (yes for token limits, cost tracking) or *service-appropriate* (yes for prompt design, output parsing)? |
| **ADR-002**: Auth at edge | LLM gateway should also validate auth before forwarding to model APIs — prevents unauthorized model calls that generate cost. Same pattern, same boundary. |
| **ADR-003**: Rate limiting | Extend rate limiting to token budgets per tenant. Existing rate limit infrastructure (Redis token bucket) can be adapted, but the counting unit changes from requests to tokens. |
| **ADR-005**: Structured access logs | Add `input_tokens`, `output_tokens`, `model_id`, `cache_hit`, `cost_usd` to the log schema. These fields enable the cost visibility that AI programs require for budget governance. |
