# Team Topology — Distributed Cache Invalidation

## Who Owns Cache Invalidation?

Distributed cache invalidation is a **complicated-subsystem** capability that sits at the intersection of multiple team boundaries. Unlike features owned by a single stream-aligned team, invalidation correctness requires coordination between:

- The team that **writes data** (produces the invalidation event)
- The platform team that **runs the message bus** and shared Redis cluster
- Every service team that **has a cache** (consumes the event and evicts the right keys)

All three must be aligned. When they aren't, invalidation silently fails and stale data persists.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | NATS JetStream infrastructure, shared Redis cluster, cache client library with built-in invalidation subscription, key schema governance |
| **Data / Write Services Teams** | Stream-aligned | Own the write path; responsible for publishing invalidation events on every data mutation |
| **Cache Consumer Teams** | Stream-aligned | Consume invalidation events; responsible for subscribing correctly and evicting the right keys from L1 and L2 |
| **SRE** | Enabling team | Owns runbooks for invalidation failures, stale data incidents, and consumer lag alerting |

The platform team provides the infrastructure and the client library. Write service teams and cache consumer teams operate within the contract the platform defines. SRE ensures the system is operable when things go wrong.

---

## Conway's Law Implications

The cache key design is a team boundary artifact. Teams that independently design their key formats will create namespace collisions in a shared Redis cluster and emit invalidation events that other teams cannot reliably consume.

**What the org structure predicts about your invalidation system:**

- **Each team owns their key format independently** → namespace collisions in Redis; invalidation events reference keys other consumers don't recognize; debugging requires cross-team coordination for every incident
- **Platform team dictates all key formats centrally** → platform team becomes a bottleneck; stream-aligned teams cannot move quickly; key design decisions require platform review tickets
- **Hybrid: canonical key format owned per entity type by the write service team, enforced by the platform library** → the team that writes the data owns the canonical key format for their data. No other team derives or guesses the key format. This is the recommended model.

The `env:tenant:version:entity:id` key scheme (documented in ADR-002) is a Conway's Law decision as much as a technical one: it forces the namespace structure to reflect the organizational boundaries (tenant ownership, versioning authority) rather than ad hoc per-team conventions.

**The shared key schema document** — owned by the platform team but contributed to by write service teams — prevents namespace drift and requires active governance. Without it, each team's "obvious" key naming creates the next cross-team incident.

---

## Failure Mode: Org Contradicts Architecture

**The "who publishes the event?" ownership gap** is the most common invalidation failure in multi-team environments.

Scenario: three teams independently build write services that update the same underlying product data (catalog service, pricing service, inventory service). Only the catalog service team was in the room when the invalidation design was built. The pricing service and inventory service teams update product records through their own write paths, but they were not part of the invalidation design and do not publish invalidation events.

Result: a price change via the pricing service leaves stale data in all L1 and L2 caches across all API instances. Requests succeed. No errors appear. A customer sees the old price for up to 60 seconds. The incident report will ask: "who publishes the event for a pricing write?" If the answer is "it depends" or "we assumed catalog handled it," the org structure has caused a correctness gap.

**Prevention:** every write service team that can mutate a cacheable entity must be listed in the invalidation event registry. This is a governance requirement, not just a technical one.

---

## Team Interaction Modes

| Interaction | Mode | Description |
|---|---|---|
| Platform → all teams | **X-as-a-service** | Platform provides Redis cluster, NATS JetStream, and cache client library. Teams call `cache.get()` and `cache.set()` — the platform handles subscribe, evict, and reconnect automatically. |
| Write service teams → platform | **Collaboration** | Write service teams register new invalidation event types in the event schema. Requires platform team review to ensure topic naming, payload format, and consumer group conventions are consistent. |
| Cache consumer teams → write service teams | **Collaboration** | Before building a cache for an entity, consumer teams agree with the write service team on the invalidation event format and key naming. This agreement must happen before implementation, not after a stale data incident. |
| SRE → all teams | **Enabling** | SRE provides incident response runbooks, consumer lag alerts, and stale data recovery procedures. During an invalidation incident, SRE coordinates across write service and consumer teams rather than requiring each team to independently investigate. |

---

## Cognitive Load Considerations

Cache invalidation failures are often invisible until a user reports stale data. A missed invalidation event does not produce an error — it produces a stale cache hit that is indistinguishable from a fresh cache hit in standard metrics. Without specific instrumentation, the problem surface is silent.

This creates high cognitive load during incident response: there is no obvious error, requests succeed, and identifying whether an instance's L1 cache missed the invalidation event requires correlating consumer lag metrics, key eviction timestamps, and application-level staleness signals.

**Mitigations:**
- The platform library emits `invalidation.consumer.lag` per instance (see OBSERVABILITY.md). Operations engineers see consumer lag alerts before users report stale data.
- The SRE runbook for "stale data reported" must be well-maintained and tested. Stale data incidents are expensive to diagnose without a clear procedure. This runbook is a team-level artifact, not just documentation.
- Post-mortem template specifically for invalidation failures: which team published the event, which consumer failed to receive it, what the lag was at the time, how the stale window was bounded by TTL.

---

## Scaling the Team Model

| Scale | Recommended model |
|---|---|
| 1–3 write services | Ad hoc invalidation events per service. Each team publishes events when they're ready. Key schema documented in a shared wiki. NATS topic per entity type. |
| 4–10 write services | Standardized invalidation event schema enforced by platform library. Shared NATS topics organized by entity type (`cache.invalidation.product`, `cache.invalidation.user`). Platform team reviews all new event type registrations. |
| 10+ write services | Change Data Capture (CDC) from origin databases (Debezium or equivalent) as the canonical event source. Eliminates the requirement for write services to explicitly publish events — the database change log is the source of truth. Write service teams no longer need to coordinate with the platform team on event publication. Platform team owns CDC connectors. |

The CDC transition at 10+ write services is a Conway's Law inflection point: coordination cost across ten write service teams exceeds the cost of moving the event source to the database layer, which is owned by a single platform team.
