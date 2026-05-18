# ADR-002: Use Redis SETNX with TTL as the deduplication store

## Status
Accepted

## Date
2025-08-20

## Context
The idempotent consumer pattern requires a deduplication store that is consulted before every message is processed. The store must meet three requirements: it must be accessible from all consumer instances (not per-process in-memory state), it must be fast enough that the check does not meaningfully increase message processing latency, and it must be reliable enough that store unavailability does not permanently block message processing.

We evaluated three options: Redis (in-memory key-value store), PostgreSQL (the existing relational database), and an in-memory hashmap with periodic persistence to disk.

The PostgreSQL option was tested first because it required no new infrastructure. Under moderate load (200 messages per second across 4 consumer instances), the deduplication check added approximately 8ms per message processing cycle due to connection acquisition overhead from the shared database pool. More critically, the deduplication queries competed with other database operations during peak traffic, causing both message processing latency and unrelated API response times to increase.

The in-memory hashmap was rejected before testing because it cannot be shared across consumer instances; each instance would have an independent deduplication state, and a message redelivered to a different consumer instance than the one that originally processed it would not be detected as a duplicate.

## Decision
Use Redis with the atomic `SET processed:{message_id} 1 NX EX {ttl_seconds}` command as the deduplication store.

The `NX` flag (set only if Not eXists) makes the check and record operations atomic: if two consumer instances receive the same redelivered message simultaneously, exactly one will get `OK` from the `SETNX` (proceed with processing) and the other will get `nil` (skip processing). This eliminates a race condition that would exist if the check and record were separate operations.

The TTL is set per-consumer based on the message broker's maximum redelivery window:
- Notification queue (max redelivery: 24 hours): TTL = 48 hours
- Payment processing queue (max redelivery: 7 days): TTL = 14 days
- Background job queue (max redelivery: 6 hours): TTL = 12 hours

TTL is set to 2x the maximum redelivery window to account for edge cases where a message may be redelivered near the end of the redelivery window.

For payment processing consumers (where losing a deduplication record due to Redis unavailability or eviction would cause a duplicate charge), the deduplication record is also written to a PostgreSQL `processed_messages` table as a durable backup. The PostgreSQL check is performed only if the Redis check fails (unavailable or the key is not found in Redis).

## Alternatives Considered

**PostgreSQL inbox table as the sole deduplication store:** Use a dedicated `processed_messages` table in PostgreSQL with `message_id` as the primary key. Insert before processing; on duplicate key, skip. Provides ACID guarantees. Rejected as the primary store because the database load test showed unacceptable latency impact at 200 messages/second. Retained as a fallback for payment processing consumers where durability is more important than latency.

**Message broker's built-in deduplication:** Some brokers (Amazon SQS FIFO, IBM MQ) provide message-level deduplication natively, using a message deduplication ID provided at publish time. Not applicable to RabbitMQ, which does not have built-in deduplication. Also not fully equivalent: broker-level deduplication applies to the delivery window but not to the processing side effects; a message can be delivered exactly once but still cause duplicate side effects if the consumer crashes after processing but before acking.

**Bloom filter for approximate deduplication:** Use a probabilistic data structure (Bloom filter) to track processed message IDs. Allows false positives (some non-duplicate messages are incorrectly flagged as duplicates) but not false negatives. Rejected because a false positive causes a legitimate message to be silently dropped -- an unacceptable outcome for payment confirmation and notification delivery. Approximate deduplication is appropriate only for analytics workloads where a small false positive rate is acceptable.

## Consequences

### Positive
- Redis `SETNX` is an atomic O(1) operation with sub-millisecond latency; the deduplication check adds less than 1ms to message processing latency under normal conditions
- Multiple consumer instances checking the same `message_id` simultaneously are handled correctly: exactly one proceeds, the rest skip
- The TTL-based expiry means no explicit cleanup is needed; old deduplication records expire automatically

### Negative
- Redis availability is now a dependency for message processing. If Redis is unavailable, consumers fall back to the PostgreSQL deduplication table (for payment consumers) or accept the risk of duplicate processing (for lower-stakes consumers)
- Redis memory pressure can cause TTL-based eviction of deduplication records before their TTL expires if `maxmemory-policy` is set to an eviction policy. The Redis instance used for deduplication must use `noeviction` policy.

### Risks
- **Redis eviction before TTL expiry.** If the Redis instance runs out of memory and evicts keys despite `noeviction` policy misconfiguration, deduplication records are lost and duplicates may occur. Mitigation: the deduplication Redis instance is monitored for memory utilization; an alert fires at 75% memory usage, well before eviction pressure would occur.

## Review Trigger
Revisit if RabbitMQ is replaced with a broker that provides at-exactly-once delivery guarantees or native deduplication, which may reduce or eliminate the need for application-level Redis deduplication.
