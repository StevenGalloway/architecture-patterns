# AI Integration — Backend-for-Frontend Pattern

## The BFF as the AI Content Layer for Each Client Surface

When AI-generated content enters a product, it faces the same problem as any other data: different client surfaces need it shaped differently. A mobile app, a web app, and a partner portal do not want the same LLM output delivered in the same format. The BFF is the correct place to bridge the gap between a general-purpose AI response and the specific rendering requirements of each client.

This extends the BFF's existing role naturally. The BFF already aggregates domain data, shapes it for its client, and applies client-specific caching and resilience. AI content is another upstream source — the LLM is a domain service that happens to return unstructured text — and the BFF handles the shaping and caching just as it does for structured domain responses.

---

## 1. Server-Side Prompt Construction

Prompts that encode business context must not be constructed on the client. A mobile app constructing a prompt from session state has two problems: the prompt construction logic is visible and modifiable by anyone with access to the app binary, and the client must transmit potentially sensitive context (user tier, purchase history, account flags) to the BFF in a form that can be intercepted.

The BFF solves this by holding the prompt construction logic server-side. The mobile client sends a simple intent signal ("show me product recommendations for this category"), and the BFF assembles the full, context-rich prompt from data it retrieves from domain services.

**Example: mobile BFF prompt construction for a product recommendation**

The mobile client issues a request:
```
GET /mobile/recommendations?category=footwear&context=cart
```

The BFF, before calling the LLM, assembles context from domain services in parallel:

```javascript
const [userProfile, currentCart, catalogContext] = await Promise.all([
  profileService.get(userId),
  ordersService.getActiveCart(userId),
  catalogService.getCategoryContext('footwear')
]);

const prompt = buildRecommendationPrompt({
  user_tier: userProfile.tier,              // "premium" — affects recommendation scope
  purchase_history_summary: userProfile.recent_categories,
  cart_items: currentCart.items.map(i => i.product_id),
  category_bestsellers: catalogContext.top_products,
  instructions: MOBILE_RECOMMENDATION_INSTRUCTIONS  // server-side constant, not client-controlled
});
```

The client receives: a shaped recommendation response. The client never sees the prompt, the user tier classification logic, or the specific products used as context. This logic is versioned and auditable on the server.

**What belongs in the BFF for prompt construction:**
- Context retrieval from domain services (profile, cart, history)
- Prompt template selection (which template based on user tier, feature flag, experiment assignment)
- Context assembly logic (which fields from each service feed into the prompt)
- Output parsing (extracting structured data from LLM text response)

**What does not belong in the BFF:**
- LLM model selection logic (this is an LLM gateway concern)
- Prompt injection defense guardrails (defense in depth: both BFF and LLM gateway layer)
- Model API key management (secrets management, not BFF concern)

---

## 2. Streaming AI Response Shaping

LLMs generate output token-by-token. Streaming this output to clients improves perceived responsiveness: the user sees the first words appear immediately rather than waiting for the full response. But streaming behaves differently for different client types, and the BFF handles this transformation transparently.

**Web BFF: token-by-token streaming**

Web browsers with WebSocket or SSE support can render tokens as they arrive. The user sees the response being written in real time. The web BFF can proxy the stream from the LLM to the browser with minimal buffering — the LLM's SSE stream becomes the client's SSE stream, with only metadata injection and field filtering applied.

```
LLM stream ─────────────────────────────────────► Web BFF ──► Browser
  token: "The"                                      │           renders: "The"
  token: " top"                                      │           renders: " top"
  token: " product"                                  │           renders: " product"
```

**Mobile BFF: buffered chunk streaming**

Mobile devices on cellular connections pay per-packet costs. A stream that delivers one token at a time (typically 3–7 bytes per SSE event) generates hundreds of small packets per response. On high-latency mobile networks, this produces worse perceived performance than waiting for a larger buffer because the overhead of individual packet acknowledgements exceeds the benefit of early rendering.

The mobile BFF buffers the LLM stream and delivers it in chunks optimized for mobile rendering:

```
LLM stream ──► Mobile BFF (buffer) ──► Mobile client
  token: "The"          │               receives: "The top product in this"
  token: " top"         │ (buffering)   receives: " category is Widget X, with"
  token: " product"     │               receives: " a 4.8 rating and free shipping."
  token: " in"          │
  token: " this"        ─────────────►  (flush: 5 words or 200ms, whichever first)
```

Buffer flush criteria for mobile BFF: flush on sentence boundary (`.`, `!`, `?`), maximum buffer age (200ms), or buffer size (50 tokens), whichever comes first. This delivers readable chunks that render well on mobile without excessive packet overhead.

**Configuration per BFF:**

```javascript
// Web BFF streaming config
const streamConfig = {
  mode: 'token',           // flush each token
  max_buffer_ms: 0,        // no buffering
  format: 'sse'            // Server-Sent Events
};

// Mobile BFF streaming config
const streamConfig = {
  mode: 'chunk',           // flush on sentence boundary or timeout
  max_buffer_ms: 200,      // never hold longer than 200ms
  min_chunk_tokens: 15,    // minimum tokens per chunk
  format: 'sse',           // still SSE; chunk size differs, not protocol
  flush_on: ['sentence', 'timeout', 'max_tokens']
};
```

---

## 3. AI Content Hydration

LLM output is text. Client surfaces need structured content — links, images, UI components, deep links, CTAs. The BFF is where AI text is hydrated into the structured format each client renders.

**Example: product recommendation from AI**

LLM returns:
```
"The top product in the Running Shoes category this week is the TrailMax Pro, 
currently priced at $129 with a 4.8-star rating and free shipping."
```

This text is accurate but not renderable as a rich mobile card. The BFF:
1. Parses the entity mention ("TrailMax Pro") using the LLM's structured output mode or a second extraction call
2. Queries the Catalog service for the product entity (image URL, product ID, current price, stock status)
3. Assembles the hydrated response for each client

**Web BFF hydration:**
```json
{
  "ai_summary": "The top product in Running Shoes this week is the TrailMax Pro...",
  "product": {
    "id": "prod_tm_pro_42",
    "name": "TrailMax Pro",
    "image_url": "https://cdn.example.com/products/trailmax-pro-main.webp",
    "price_display": "$129.00",
    "rating": 4.8,
    "rating_count": 2847,
    "badge": "Free Shipping",
    "add_to_cart_url": "/cart/add?product_id=prod_tm_pro_42",
    "detail_url": "/products/trailmax-pro"
  }
}
```

**Mobile BFF hydration (different schema):**
```json
{
  "summary_text": "Top pick: TrailMax Pro",
  "product": {
    "id": "prod_tm_pro_42",
    "image_url": "https://cdn.example.com/products/trailmax-pro-mobile-card.webp",
    "price": 129.00,
    "rating_stars": 4.8,
    "badge_text": "Free Shipping",
    "deep_link": "myapp://products/trailmax-pro",
    "action": { "type": "add_to_cart", "product_id": "prod_tm_pro_42" }
  }
}
```

The LLM returned the same text to both BFFs. Each BFF's hydration layer transformed it into the schema its client renders natively. The mobile BFF uses a square card image URL (pre-cropped variant), a native deep link instead of a web URL, and a structured action object the mobile SDK understands directly. The web BFF uses the full web image, web URLs, and a rating count (which the mobile card omits for space).

**Hydration failure handling:** If the Catalog service lookup fails (entity not found, or service timeout), the BFF falls back to returning the AI text without hydration. The client renders the text summary without the product card. This partial response is preferable to failing the entire recommendation request.

---

## 4. AI Response Caching at the BFF Layer Per Client Type

LLM responses are expensive. For recommendation and content generation endpoints, the cost per response is in the $0.01–$0.10 range per user request depending on model and prompt size. At 1 million daily active users, uncached AI responses can cost $10,000–$100,000/day for AI-driven features alone.

The BFF is the right cache layer because:
- The cache key can incorporate user profile context, not just the raw request URL
- Each BFF can apply a TTL appropriate for its client's freshness requirements
- The BFF already has the domain service context needed to construct a meaningful cache key

**Cache key design:**

Do not cache on the raw prompt text. Prompts include user-specific context that is assembled by the BFF and will differ for every user even for the same recommendation type. Cache on a hash of the stable context dimensions:

```javascript
const cacheKey = `${bffClientType}:${endpointName}:${hash({
  user_tier: userProfile.tier,
  user_category_affinity: userProfile.top_3_categories,  // stable for ~24h
  experiment_group: userProfile.experiment_assignment,    // stable for experiment duration
  // NOTE: do not include cart contents (too volatile)
  // NOTE: do not include timestamp (too specific)
})}`;
```

This cache key is stable for a user whose profile and experiment assignment have not changed. When a user upgrades their tier or is assigned to a new experiment, the hash changes and the cache misses, triggering a fresh LLM call.

**Per-BFF TTL configuration:**

| BFF | Cache TTL | Rationale |
|---|---|---|
| Mobile BFF | 15 minutes | Battery and bandwidth cost of re-fetching is significant. Recommendation freshness at 15-minute granularity is acceptable for mobile browsing. |
| Web BFF | 5 minutes | Web sessions are more interactive. Users expect content to refresh within a single session. Shorter TTL provides better personalization responsiveness. |
| Partner Portal BFF | 60 minutes | Partner data access is analytical, not real-time. Longer TTL reduces LLM API costs for high-volume partner API calls. |

**Cache invalidation triggers:**
- User updates their profile explicitly (preference change, tier upgrade): invalidate all cache keys for that user hash across all BFFs
- New product launch in a category the user has affinity for: selective invalidation by category affinity key component
- Experiment assignment change: the hash changes automatically; no explicit invalidation needed

**Cache storage:** Per-BFF Redis instance. Not shared across BFFs. Shared cache would require the shortest TTL of any BFF to apply universally (see COST-ANALYSIS.md), which defeats the mobile BFF's battery/bandwidth optimization.

---

## AI Content as a New Class of Partial Response

AI-generated content introduces a failure mode the BFF must handle explicitly: the LLM call succeeds, but the hydration step fails (Catalog service is down, so product entities cannot be resolved). This is neither a full success nor a full failure.

The BFF's partial response model handles this:

```javascript
const result = {
  ai_summary: llmResponse.text,          // always present if LLM succeeded
  product: null,                          // null if hydration failed
  hydration_status: 'failed',             // explicit signal to client
  degraded: true                          // client renders text-only fallback
};
```

The client renders the AI text without the product card. The user sees "The top product in Running Shoes this week is the TrailMax Pro." without the image, price, and add-to-cart button. This is degraded but functional — better than a blank screen.

This partial response behavior must be documented in the BFF's API contract so the mobile and web apps handle the `degraded: true` state explicitly rather than crashing on a null product object.
