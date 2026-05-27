# ADR-002: Use token bucket for bursts and quotas for fairness

## Status
Accepted

## Date
2025-09-10

## Context
Once rate limiting was adopted at the edge (ADR-001), we needed to choose the specific algorithms. Two different enforcement requirements mapped to two different problems:

**Request shaping for normal client behavior:** Mobile apps reconnect after a period of background inactivity and may make 5-10 requests in quick succession (refreshing a feed, syncing state, loading initial data). This burst of 10 requests over 3 seconds is legitimate client behavior; it should not be penalized. But a client that sustains 300 requests per minute continuously is not normal usage and should be throttled.

**Fairness enforcement for API monetization:** The API is offered on tiered plans (Starter: 10,000 requests/day; Professional: 100,000 requests/day; Enterprise: custom). These quotas must be enforced over a day-length window. A Starter plan client that burns through 10,000 requests in the first hour of the day should not be able to continue making requests for the remaining 23 hours. But the daily quota should reset reliably at the same time each day.

A fixed window counter (increment on each request, reset at the end of the window) addresses the quota requirement but not the burst requirement: a fixed window allows 2x the window's limit to be used at a window boundary (all tokens at the end of one window, all tokens at the start of the next). A single algorithm that addresses both requirements in the same enforcement mechanism was preferable to two separate algorithms.

## Decision
Two complementary algorithms are used:

**Token bucket (per-IP and per-API-key, per route group):** Tokens are added to a bucket at a constant refill rate. Each request consumes one token. If the bucket is empty, the request is rejected with 429. The bucket has a maximum capacity (burst size) that a client can accumulate during idle periods and spend during bursts.

Configuration for catalog endpoints:
- Refill rate: 10 tokens/second (600 requests/minute sustained rate)
- Bucket capacity: 50 tokens (burst allowance for reconnects and page loads)
- This allows a client to burst 50 requests immediately after an idle period, then sustain 10 requests/second thereafter

Configuration for authentication endpoints:
- Refill rate: 0.5 tokens/second (30 requests/minute sustained rate)
- Bucket capacity: 10 tokens (allows normal login flows without penalty)

**Daily quota (per-API-key, plan-based):** A daily counter increments on each request for a given API key. The counter expires at UTC midnight. When the counter exceeds the plan's daily limit, all subsequent requests from that API key return 429 for the remainder of the day.

The token bucket and quota operate independently: a request must pass both the token bucket check and the quota check to proceed. The token bucket prevents short-term burst abuse; the daily quota prevents sustained overconsumption by plan-tier clients.

## Alternatives Considered

**Fixed window counter for both rate limiting and quota:** Use a sliding or tumbling window counter for all limits. Simple to implement with Redis INCR + TTL. Rejected as the primary algorithm for per-IP rate limiting because fixed windows allow 2x burst at window boundaries -- a client can exhaust a 1-minute window at 23:59:59 and immediately exhaust the next window at 00:00:00, effectively sending 2x the limit in 2 seconds. Token buckets prevent this by carrying over deficit across time.

**Leaky bucket instead of token bucket:** The leaky bucket algorithm processes requests at a constant rate, queuing excess requests rather than rejecting them. This provides smooth output but requires an unbounded or bounded queue for excess requests. Rejected because queuing excess requests consumes memory (for the queue) and time (the queued request waits before being processed). Fail-fast rejection (token bucket) is preferable to queuing for an API rate limiter.

**Sliding window log:** Record the timestamp of each request and count requests within the sliding window period. More accurate than fixed windows for sustained rate enforcement. Rejected because it requires storing one entry per request in the rate limit store, which at high request volumes creates memory pressure in Redis.

## Consequences

### Positive
- Mobile app reconnect burst behavior (the motivating use case) is handled correctly: the 50-token burst capacity absorbs the initial reconnect burst without rejecting legitimate requests
- The daily quota enforcement is accurate and predictable: API key holders know their daily limit and can plan around the UTC midnight reset
- The two algorithms operate independently: a high-burst legitimate client that stays within its daily quota is not penalized by the token bucket, and a plan-limit abuser is caught by the quota even if their burst rate is within the token bucket limit

### Negative
- Token bucket requires per-request Redis operations (INCR or Lua script for atomic token consumption), which adds latency to every request in the rate-limited path
- The burst capacity configuration must be tuned per route group; a burst capacity that is too generous provides insufficient protection against bots that simulate human burst patterns

### Risks
- **Token bucket Lua script atomicity failure.** The token bucket state must be updated atomically (read tokens, subtract one, write back). Without atomic operations, concurrent requests can observe the same token count and both be allowed when only one should be. Mitigation: the token bucket check uses a Redis Lua script that performs the read-check-decrement atomically in a single command.

## Review Trigger
Revisit burst capacity values after analyzing client traffic patterns post-deployment. Revisit the daily quota reset time (UTC midnight) if a significant proportion of customers are in a single timezone where midnight UTC corresponds to a business-active time (creating a "rate limit resets at noon" effect for customers in UTC+12).
