# Idempotent Consumer Pattern (Enterprise-Ready)

## Summary
In distributed systems, message delivery is typically **at-least-once**, meaning **duplicates can occur** (retries, redeliveries, timeouts, consumer restarts). The **Idempotent Consumer** pattern ensures that processing the same message more than once does **not** produce duplicate side effects.

Common techniques:
- **Deduplication store** keyed by `message_id` / `event_id` (DB/Redis)
- **Idempotency key** embedded in the business operation (unique constraints)
- **Upsert** semantics and compare-and-swap
- **Inbox table** (durable) + transactional processing

This repository demonstrates idempotency using **Redis SETNX + TTL** alongside a message broker.

---

## Problem
A consumer receives a message and applies side effects:
- charge a card
- create an invoice
- send an email
- write to a database

If the broker redelivers the same message (or the producer resends), you can accidentally:
- double-charge
- create duplicate records
- send duplicate notifications

---

## Constraints & Forces
- Brokers often provide **at-least-once**, not exactly-once
- Consumers crash mid-processing; ack may not be committed
- Network timeouts cause retries
- Scaling out adds concurrency (same key can land on multiple instances)
- Idempotency must cover **side effects**, not just “code runs once”

---

## Solution
### 1) Include a stable message identifier
Every message must carry a stable **idempotency key**:
- `message_id` (UUID) or `event_id`
- should not change across retries/resends

### 2) Check-and-record before applying side effects
Use a dedupe store to atomically record processing:
- `SETNX processed:{message_id} = 1` with TTL in Redis
- If already present → skip work and **ack**

### 3) Make side effects idempotent where possible
- DB unique constraints on natural keys
- upserts / “insert if not exists”
- idempotent external API calls (idempotency headers)

---

## When to Use
- Any asynchronous processing where duplicates are plausible (most systems)
- Payment/invoicing/shipping workflows where duplicates are expensive
- Systems using retries, DLQs, redelivery, or manual replays

## When Not to Use (rare)
- In-process events in a monolith with a single transaction
- Workloads where duplicates are acceptable (e.g., some analytics events)

---

## Tradeoffs
### Benefits
- Safe retries and at-least-once delivery
- Simpler than trying to force exactly-once semantics
- Enables operational replay/backfill

### Costs / Risks
- Requires a dedupe store (Redis/DB) and retention policy
- Must choose TTL/retention to match replay windows
- Poison messages still need DLQ strategy and runbooks

---

## Failure Modes & Mitigations
1. **Redis unavailable**
   - Mitigation: fail closed for high-stakes effects (do not process) + alert
2. **TTL too short**
   - Mitigation: size TTL to your maximum replay window
3. **Message has unstable ID**
   - Mitigation: enforce schema contracts; validate presence/format of `message_id`
4. **Side effect partially applied before marking processed**
   - Mitigation: use transactional inbox/outbox approach for strict guarantees
5. **Poison message loops**
   - Mitigation: retry limit + DLQ + manual remediation

---

## Diagrams
- `diagrams/01-context.mmd`
- `diagrams/02-idempotent-consume-sequence.mmd`
- `diagrams/03-retries-dlq-ops.mmd`

---

## ADRs
- `adrs/ADR-001-adopt-idempotent-consumer.md`
- `adrs/ADR-002-dedup-store-redis-ttl.md`
- `adrs/ADR-003-message-contract-and-ids.md`
- `adrs/ADR-004-ack-retry-and-dlq.md`
- `adrs/ADR-005-observability-and-runbooks.md`

---

## Example (New Tech)
This example uses **.NET 8 (C#) + RabbitMQ + Redis** (different from previous Go/Python/Kotlin examples):
- `producer`: publishes messages with `message_id`
- `consumer`: consumes and dedupes with Redis `SETNX` before applying side effects
- `infra`: docker-compose for RabbitMQ and Redis

See `examples/dotnet-rabbitmq-redis/`.
