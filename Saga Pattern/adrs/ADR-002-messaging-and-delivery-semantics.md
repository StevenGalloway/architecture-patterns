# ADR-002: Use RabbitMQ with at-least-once delivery for saga messaging

## Status
Accepted

## Date
2025-09-24

## Context
The saga orchestrator and its three participant services communicate asynchronously. We considered making the orchestrator call participant services over HTTP, but that would couple the orchestrator's availability to each participant -- if Inventory is slow, the orchestrator blocks. Synchronous calls also have no built-in retry or backpressure mechanism, which was essentially the root cause of the production incident this saga pattern was introduced to prevent.

We already operate RabbitMQ for other event-driven workflows in the platform. The infrastructure cost of adding a few new queues and exchanges is low, and the team has operational experience with RabbitMQ clustering, message persistence configuration, and dead-letter queue setup.

## Decision
We use RabbitMQ for all saga messaging with at-least-once delivery semantics.

Queue topology:
- One durable command queue per participant: `orders.payment.commands`, `orders.inventory.commands`, `orders.shipping.commands`
- One durable event exchange for saga results: `orders.saga.events`, fanout to the orchestrator's reply queue
- All queues and messages are durable (`delivery_mode=2`); messages survive a RabbitMQ restart
- Consumer acknowledgment is manual; messages are nacked and re-queued on processing failure, dead-lettered after three retries

Because RabbitMQ guarantees at-least-once delivery, duplicate messages are expected under normal retry conditions. Every command handler and the orchestrator itself must be idempotent on message IDs. This is a hard design constraint enforced at code review, not an optional safeguard.

## Alternatives Considered

**Synchronous HTTP calls from orchestrator to participants:** Simpler to implement but creates tight availability coupling. If any participant is slow or restarting during a deploy, the orchestrator's goroutine pool fills up and blocks all in-flight orders. Rejected -- this was effectively the failure mode we experienced before.

**Kafka instead of RabbitMQ:** Kafka's durable log and consumer group semantics make replay easier. Rejected for this specific use case because we need per-service command delivery, not a shared ordered log. RabbitMQ's dedicated-queue model is a better fit for command dispatch, and the team already operates it in production.

**In-memory channels with a persistent outbox:** The orchestrator could use in-memory Go channels and persist commands to an outbox table for reliability. Rejected because it pushes message broker responsibility into the orchestrator, increasing its complexity. RabbitMQ provides this durability out of the box.

## Consequences

### Positive
- Participant services are decoupled from the orchestrator and process commands at their own pace
- RabbitMQ provides natural backpressure via queue depth; participants are never overwhelmed
- Dead-letter queues give a safe landing zone for poison messages rather than silent drops
- The operations team already has dashboards, alerts, and runbooks for RabbitMQ

### Negative
- At-least-once delivery makes idempotency mandatory for every command handler -- there is no shortcut
- DLQ depth must be actively monitored; a growing DLQ means orders are silently stuck
- Queue topology (names, bindings, exchange configuration) must be documented and kept in sync across service repos

### Risks
- **RabbitMQ cluster outage blocks all in-flight orders.** Mitigation: run as a three-node cluster with quorum queues, which tolerate one-node failures without message loss. Health check and alert on cluster membership changes.

## Review Trigger
Revisit if the saga expands to include more than five participant services, or if event replay becomes a product requirement. At that scale, Kafka's log retention and consumer group model may be a better fit than RabbitMQ queues.
