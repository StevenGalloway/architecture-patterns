# ADR-004: Standardize client contract for throttling responses

## Status
Accepted

## Date
2026-01-07

## Context
After rate limiting was deployed, the first wave of client complaints came from partner API consumers whose code was not prepared to handle 429 responses. Partners had built integrations under the assumption that the API would always respond with data or a 5xx error; 429 was a new response code that their error handling code did not handle, and in many cases the integration code entered a retry loop that ignored the 429 and retried immediately.

Immediate retry on 429 is exactly the wrong behavior: it sends more requests to an already-limited client, consuming the bucket's remaining tokens even faster and potentially triggering the limit repeatedly. Without any guidance from the response on when to retry, partners defaulted to their generic retry behavior, which typically included immediate retries or short fixed delays.

A second complaint was from partners who wanted to implement proactive rate limit management (slowing down their request rate before hitting the limit), but had no way to know their current usage level without waiting for a 429.

Both problems -- how to respond correctly to a 429, and how to monitor usage before reaching the limit -- are solved by standardized response headers that communicate the client's current limit state on every request.

## Decision
The following response headers are included on every API response (not just 429 responses):

- `X-RateLimit-Limit`: The maximum number of requests allowed per the current window. For token bucket limits, this is the bucket capacity (burst size). For quota limits, this is the daily quota for the client's plan.
- `X-RateLimit-Remaining`: The number of requests remaining before the limit is reached. For token bucket, this is the current token count. For quota, this is daily_limit minus today's request count.
- `X-RateLimit-Reset`: Unix timestamp (seconds) when the limit resets. For token bucket, this is the time when the bucket will be full (at the current refill rate). For quota, this is the next UTC midnight.

On 429 responses specifically:
- HTTP status code: 429 Too Many Requests
- `Retry-After`: Integer seconds until the client should retry. For token bucket, this is the number of seconds until at least one token is available. For quota, this is seconds until UTC midnight.
- Response body: JSON object with `error.code` (`RATE_LIMIT_EXCEEDED` or `QUOTA_EXCEEDED`) and `error.message` explaining which limit was hit

**Documentation commitment:** The rate limit headers and 429 response format are documented in the public API documentation as a stable contract. Changes to the header names or semantics are treated as breaking API changes.

## Alternatives Considered

**Include rate limit headers only on 429 responses:** Only send the headers when a limit is hit, not on every request. Reduces response overhead for requests that are not near the limit. Rejected because the value of the headers for proactive monitoring (the second partner complaint) depends on them being available on every request, not just on 429s. A client that wants to slow down its request rate before hitting the limit needs to see the remaining token count on normal successful responses.

**Provide a dedicated rate limit status endpoint:** Expose a `/rate-limits/status` endpoint that clients can poll to check their current usage. Rejected as the primary approach because polling a status endpoint adds a separate request for each status check, and the information is stale by the time the actual API request is made. Headers on the actual API response provide current status at zero additional request cost.

**Use IETF standardized headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset):** The IETF drafted a standard for rate limit headers without the `X-` prefix (`RateLimit-*`). Accepted as the migration target: the current implementation uses `X-RateLimit-*` because most existing API client libraries expect that format. A non-breaking migration to the IETF standard names is planned once the IETF draft reaches RFC status and major client libraries support it.

## Consequences

### Positive
- Partners who implement the `Retry-After` header in their retry logic will correctly back off when rate limited, reducing the retry storm pattern
- The `X-RateLimit-Remaining` header on successful responses enables proactive usage monitoring without requiring a separate status endpoint
- Standardized headers enable client library authors to implement intelligent retry behavior once (consuming the headers) rather than requiring each integration to hard-code retry delays

### Negative
- Including rate limit headers on every response adds a small amount of overhead (3 additional HTTP headers) to each API response
- The `Retry-After` calculation for token bucket limits (seconds until next token) can fluctuate for clients that are near but not at the limit, which may cause confusion for clients that display the retry time to end users

### Risks
- **Client ignores Retry-After and retries immediately.** Despite the `Retry-After` header, some clients will retry without respecting the backoff period, especially legacy code that handles 429 as a generic HTTP error. Mitigation: the API gateway applies an escalating penalty for clients that ignore `Retry-After` -- repeated 429 violations within the `Retry-After` window result in a longer lockout period (1 minute, then 5 minutes) for that API key.

## Review Trigger
Revisit the header naming (`X-RateLimit-*` vs. the IETF `RateLimit-*` draft) when the IETF draft reaches RFC status and major API client libraries adopt the IETF standard names.
