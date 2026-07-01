# AI Integration — Caching Strategies

## Caching as a First-Class Concern in AI Systems

Caching matters more in AI workloads than in any other class of application. LLM API calls are 100–10,000× more expensive per request than a database read. A cache miss in a traditional application costs microseconds of database IO; a cache miss in an LLM application costs 500–5,000ms of model inference time and $0.001–$0.10 per call in API cost. The economic pressure to cache AI outputs is proportionally higher, and so is the engineering complexity of doing it correctly.

Five distinct caching problems arise in AI systems, each requiring a different strategy.

---

## 1. Semantic Caching for LLM Responses

Traditional caching uses exact key matching: the same input produces the same key. This fails for LLM workloads because "What's the capital of France?" and "What is France's capital city?" are semantically identical but produce different strings, and therefore different cache keys.

Semantic caching replaces exact string matching with embedding-based similarity search:

```
Request: "What's the capital of France?"
    ↓
Embedding model (e.g., text-embedding-3-small)
    ↓
Vector: [0.021, -0.843, 0.192, ...]
    ↓
pgvector / Pinecone similarity search (cosine similarity)
    ↓
Nearest cached embedding: "What is the capital of France?" → similarity: 0.97
    ↓
Threshold check: 0.97 > 0.95 → CACHE HIT
    ↓
Return cached LLM response (no model call)
```

When no match exceeds the similarity threshold:
```
CACHE MISS → call LLM API → store response + embedding → return to caller
```

**Cost impact:** semantic caching reduces LLM API calls by 40–60% in typical customer-facing workloads where users ask similar questions. At $0.015/1K output tokens for a capable model, and an average response of 500 tokens, each cache hit saves $0.0075. At 100K daily requests with 50% hit rate, that's $375/day saved — roughly $11,000/month from a Redis + pgvector infrastructure that costs $300–800/month.

**Similarity threshold calibration:** 0.95 is a starting point, not a universal answer. For factual Q&A (capitals, definitions), 0.90 is safe. For code generation or domain-specific advice, use 0.97–0.99 to avoid returning a slightly different answer for a meaningfully different question. Instrument false positive rate (user reports the cached answer was wrong for their question) and adjust threshold accordingly.

**Cache key structure for semantic cache:**
```
embedding_model_version: text-embedding-3-small-v1
namespace: {tenant_id}:llm_responses:{feature_name}
similarity_threshold: 0.95
ttl: 3600  # 1 hour; LLM knowledge is perishable
```

---

## 2. KV Cache for Transformer Attention (Inference Infrastructure)

The "KV cache" (key-value cache) is a core concept in transformer-based language model inference and has direct implications for how you size memory on inference infrastructure.

During LLM text generation, the model computes attention over all preceding tokens at each generation step. Without caching, recomputing attention over a 10,000-token prompt at every generation step is O(n) per step, where n is the prompt length. The KV cache stores the computed attention keys and values for all preceding tokens so they are not recomputed at each step.

**Memory sizing implications:**

For a 70B parameter model:
- KV cache memory per token: approximately 1.25MB per token in FP16
- 128K context window: 128,000 × 1.25MB = 160GB KV cache memory for a single sequence
- Batch size of 8 concurrent sequences: 1,280GB KV cache memory requirement

This is why H100 GPU clusters for large model inference are not just about compute — memory bandwidth and capacity for the KV cache often drives infrastructure decisions more than FLOPS.

**What this means for system architecture:**
- Prefix caching: cloud inference APIs (Anthropic, OpenAI) cache KV states for repeated prompt prefixes. If your system prompt is 2,000 tokens and is identical across 95% of requests, you pay for that computation once instead of on every request. This is why Anthropic's prompt caching feature reduces cost by 90% on the cached prefix portion.
- Request batching: inference servers batch requests with overlapping prefixes to maximize KV cache reuse. System design that makes prefixes predictable and reusable directly reduces inference cost.
- Context window sizing: a 128K context window with full KV cache is not "free" — it has a memory cost that limits concurrent batch size. Choosing the right context window size for your workload is a cost optimization, not just a capability decision.

---

## 3. Embedding Cache for RAG Retrieval

Vector embeddings for RAG (Retrieval-Augmented Generation) retrieval are expensive to compute and change infrequently relative to how often they are read.

**Cost at scale:** OpenAI text-embedding-3-small costs $0.02/1M tokens; text-embedding-ada-002 costs $0.10/1M tokens. For a knowledge base of 500,000 document chunks averaging 512 tokens each:
- Total tokens: 256M
- Embedding cost (ada-002): $25.60 one-time
- Re-embedding cost on each query at read time: $0.10 × (daily queries × avg tokens per query)
- At 50,000 daily queries × 200 tokens: $1.00/day → $30/month in embedding API costs for query embeddings alone

Caching strategy for embeddings:

```
Cache key: sha256(document_id + ":" + chunk_index + ":" + model_version)
Cache value: float32 vector of dimension 1536 (ada-002) or 3072 (text-embedding-3-large)
TTL: no expiry (embeddings are deterministic for a given model version)
Invalidation trigger: document_updated CDC event → delete keys matching document_id prefix
```

**Model version in the cache key is critical.** When you upgrade embedding models, cached embeddings from the old model are incompatible with vectors in your vector database (different dimensionality and semantic space). Including model version in the key allows old and new embeddings to coexist during migration, and makes the migration boundary explicit.

**Invalidation on document update:**
```
CDC event: documents.updated → { document_id: "doc_abc123", updated_at: "..." }
    ↓
Invalidation subscriber evicts: sha256("doc_abc123:*:text-embedding-3-small-v1")
    ↓
Next retrieval re-embeds affected chunks
```

---

## 4. Multi-Tier Caching for Model Output

AI systems benefit from a tiered caching approach where each tier has different invalidation semantics and freshness requirements:

| Tier | Location | Lookup type | Latency | TTL | Invalidation trigger |
|---|---|---|---|---|---|
| **L1** | In-process memory (per-instance) | Exact key match | < 0.1ms | 60 seconds | Process restart, explicit evict |
| **L2** | Redis shared cache | Exact key match | < 5ms | 5–60 minutes | Feature flag change, explicit evict |
| **L3** | pgvector semantic cache | Cosine similarity search | 5–20ms | 1–24 hours | Semantic drift detection, TTL |
| **L4** | Persistent store (Postgres / S3) | Exact key match | 20–100ms | Days to weeks | Document update CDC, manual invalidation |

**L4 (persistent) is appropriate for:**
- Long-lived summarizations that are expensive to regenerate (e.g., executive summary of a 100-page PDF: $0.50–$2.00 to generate; stable for weeks)
- Distillations of large document corpora that don't change frequently
- User-specific personalized content that took minutes to generate

**Freshness contract per tier:**
- L1/L2: near-real-time data where a 1-60 minute stale read is acceptable
- L3 (semantic): responses to questions where the answer is stable (factual, not time-sensitive)
- L4 (persistent): long-form generated content anchored to a specific document version

Do not use L4 persistent caching for time-sensitive AI responses (today's news summary, current pricing, live inventory) — the staleness window is too wide and the invalidation trigger is harder to define.

---

## 5. Cache Warming for Cold-Start AI Features

A new AI feature at launch has an empty cache. If the feature is popular, the first minutes after launch generate a thundering herd: every unique request misses the cache and goes directly to the LLM API simultaneously.

At launch, 10,000 users ask "How do I reset my password?" within the first five minutes. 10,000 identical prompts → 10,000 LLM API calls → $50–$500 in API cost in five minutes → LLM API rate limit hit → 429 errors → feature degraded at the moment of highest visibility.

**Cache warming strategy:**

1. **Pre-compute popular prompts before launch:** analyze historical query logs from support tickets, search queries, or similar features to identify the top 1,000 likely prompts
2. **Batch-generate responses offline** (24–48 hours before launch) using the same model and system prompt configuration
3. **Load into L2 (Redis) and L3 (semantic vector store)** with a warm TTL (4–8 hours) so first-request users hit the cache
4. **Monitor semantic cache hit rate at launch:** if it drops below 40%, the pre-computed prompts didn't cover the actual query distribution well — expand coverage for the next launch

**Warm-up from production logs:** for features migrating from an existing system, export the 90th-percentile query distribution from production logs, generate embeddings, and bulk-insert into the semantic cache vector store. This pre-warms the semantic cache with real query semantics rather than guesses.

```
Pre-launch pipeline:
historical_queries.csv
    → deduplicate and cluster by semantic similarity
    → select cluster centroids (top 1,000 representative queries)
    → batch embed (embedding API)
    → batch generate LLM responses
    → bulk insert into pgvector + Redis
    → validate hit rate on held-out sample before launch
```

---

## Mapping Existing Caching ADRs to AI Workloads

| Existing decision | AI workload implication |
|---|---|
| **ADR-001**: Cache-aside as default | LLM semantic caching adds a step: embed before lookup, not just hash. The cache-aside pattern still applies, but the "lookup" is a vector search, not a key get. |
| **ADR-002**: SWR and stampede protection | LLM responses are expensive enough that stampede protection is critical. A lock-based stampede prevention strategy (only one caller regenerates; others wait) is more important here than for database-backed caches. |
| **ADR-003**: Key design and TTL policy | Embedding model version must be part of the semantic cache key. TTL must account for knowledge cutoff: a cached answer about "current" events expires faster than a cached answer about stable facts. |
| **ADR-004**: Invalidation via events | Document update CDC events must invalidate both the embedding cache and any semantic cache entries that used that document as retrieval context. The invalidation fan-out is broader than for non-AI caches. |
| **ADR-005**: Observability and SLOs | Add LLM-specific metrics: semantic cache hit rate, embedding compute cost avoided, LLM API cost per day (cached vs. uncached). The SLO for AI caching is partly a cost SLO, not just a latency SLO. |
