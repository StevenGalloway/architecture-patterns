# ADR-005: Define consistency expectations and optional read-your-writes

## Status
Accepted

## Date
2026-01-07

## Context
CQRS introduces an eventual consistency gap between the write side and the read side. Under normal operating conditions, the projector processes events within 200-500ms of emission. However, from the user interface perspective, this gap is not always acceptable.

A specific user complaint emerged after CQRS was deployed for order history: customers who submitted an order and immediately navigated to their order history page would sometimes not see their new order for several seconds. The order existed in the write database, the domain event had been emitted, but the projector had not yet updated the order history read model. The customer would then refresh the page, or call customer support to ask why their order was not showing.

This is the "read your own writes" consistency requirement: a user who performed a write operation expects to see the result of that write in subsequent reads, even if the underlying system is eventually consistent.

The decision was not to make all reads strongly consistent -- that would negate the performance benefits of CQRS. The decision was to define which reads have a hard consistency requirement and provide a mechanism to meet that requirement for those specific cases.

## Decision
**Default consistency:** All query endpoints are eventually consistent. The API documentation and client libraries communicate this expectation. Most reads do not have a read-your-writes requirement, and eventual consistency is acceptable.

**Read-your-writes for specific flows:** For endpoints where the user's most recent write must be visible, the query endpoint supports a `consistent=true` query parameter. When `consistent=true` is requested:

1. The query handler checks the projector's current lag metric for the relevant aggregate ID
2. If the projector's last processed event for that aggregate is at or after the write's `event_id` (passed by the client in a `X-After-Event-ID` header), the read model is current enough and the query proceeds normally
3. If the projector has not yet processed the relevant event, the handler waits up to 3 seconds for the projector to catch up, polling every 200ms
4. If the 3-second timeout is reached, the handler falls back to querying the write-side database directly for the specific aggregate

The `consistent=true` path is used only for:
- `/orders/{id}` immediately after order creation (order detail page after checkout)
- `/orders/{id}` immediately after a status change (confirmation page after an action)

All other query endpoints remain eventually consistent.

## Alternatives Considered

**Strong consistency for all reads via write-side passthrough:** All reads go to the write-side database; the read model is used only for complex aggregation queries that cannot be served from the write side efficiently. Rejected because it collapses the CQRS benefit for the majority of reads. The performance problem that motivated CQRS was that all reads were going to the write database; reverting to that model for consistency reasons negates the architectural decision.

**Client-side polling with exponential backoff:** After a write, the client polls the query endpoint until the new data appears, with backoff between attempts. Rejected as the primary solution because it shifts the consistency burden to clients and produces a poor user experience: a user navigating to order history should not see a blank or stale state for multiple seconds while the client polls.

**Write-side response includes computed read model fields:** The command response includes the data that would appear in the read model, so the client can display it immediately without querying the read side. Applicable for simple cases (the order creation response includes the order summary data). Adopted as a complement, not a replacement: some views require aggregated read model data that cannot be computed from a single write operation's response.

## Consequences

### Positive
- The checkout confirmation flow (most user-visible read-your-writes requirement) always shows the new order immediately, eliminating the category of customer support contacts driven by "my order didn't appear"
- The majority of reads remain eventually consistent and benefit from the full read model performance
- The write-side fallback for the `consistent=true` path means the worst case (projector lag exceeds 3 seconds) degrades to write-side query performance rather than returning stale data

### Negative
- The `X-After-Event-ID` header must be set by clients correctly; if a client does not include it, the `consistent=true` path falls back to checking overall projector lag, which may not be specific enough to guarantee consistency for a specific write
- The 3-second wait in the consistent-read path holds a request thread open; under load, this can consume thread pool capacity

### Risks
- **Consistent-read path overused.** If developers add `consistent=true` to endpoints that do not require it (as a defensive measure), the load on the consistent-read path may be disproportionate. Mitigation: `consistent=true` requires explicit justification in the endpoint implementation comment, and its usage is tracked as a metric to detect overuse.

## Review Trigger
Revisit if the projector's normal lag decreases to under 50ms consistently, at which point the read-your-writes mechanism may be unnecessary for most flows. Also revisit if the 3-second timeout causes observable thread pool pressure under peak load.
