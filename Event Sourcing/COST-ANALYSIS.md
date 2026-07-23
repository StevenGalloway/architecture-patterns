# Cost Analysis — Event Sourcing Pattern

## Cost Model Overview

Event Sourcing has a fundamentally different cost profile from traditional CRUD persistence. The primary difference: **events are immutable and accumulate forever**. A CRUD system's storage cost is bounded by the number of current records. An event-sourced system's storage cost is bounded by the total number of business facts that have ever occurred — which grows linearly with time and transaction volume without bound.

This is not a reason to avoid Event Sourcing. It is a reason to plan the cost model explicitly from day one.

---

## Cost Drivers

| Cost Driver | Description | Cost Lever |
|---|---|---|
| **Event log storage** | Primary store for all events, forever. Grows linearly. Cannot be truncated without losing audit trail. | Archive to cold storage (S3 Glacier) after 90 days for events not needed in hot replay |
| **Snapshot storage** | Periodic snapshots of aggregate state to speed rehydration. Bounded by number of live aggregates × snapshot frequency. | Snapshot frequency directly trades storage cost against rehydration latency |
| **Projection compute** | CPU for the projector process consuming events and building read models. Runs continuously. | Projector efficiency (batch vs. per-event processing), choice of read model store |
| **Read model database** | Query-optimized store for projections (PostgreSQL, Redis, Elasticsearch). Sized for query load, not event volume. | Choose the cheapest store that satisfies query SLOs |
| **Replay compute** | CPU-intensive batch processing during backfills. Spikes 10–50x normal projection compute during full replays. | Pre-provision reserved capacity for replay jobs; do not run on the same compute as live projectors |
| **Schema registry** | Hosted schema registry for event validation and compatibility checks. Often overlooked. | Use managed offerings (Confluent Schema Registry, AWS Glue) rather than self-hosting |

---

## Option Comparison

### Option A: PostgreSQL as Event Store (Self-Managed)

Use a single PostgreSQL database with an append-only `events` table. No specialized event store software.

**Included:** Storage, write path, basic replay via SQL. **Not included:** Built-in projection engine, native streaming, snapshot management API, operational tooling.

| Tier | Event Volume | Storage | Compute | Total/Month |
|---|---|---|---|---|
| Small | 10M events/month | ~15 GB/month at ~1.5 KB/event → ~$3 (EBS gp3) | db.t3.medium RDS → ~$60 | **~$65/month** |
| Medium | 100M events/month | ~150 GB/month accumulated → ~$30 (EBS gp3) | db.r6g.large RDS → ~$175 | **~$210/month** |
| Large | 1B events/month | ~1.5 TB/month accumulated → $150 (+ archival) | db.r6g.2xlarge + read replicas → ~$700 | **~$900/month** |

**Best for:** High event volume where operational maturity exists. PostgreSQL is the lowest unit cost but requires you to build replay infrastructure, snapshot management, and projection monitoring from scratch.

---

### Option B: EventStoreDB (Managed Cloud)

Fully managed EventStoreDB with native streaming, projection engine, and replay API.

**Included:** Event store, streaming subscriptions, server-side projections, replay API, built-in monitoring. **Not included:** Read model databases (separate cost).

| Tier | Event Volume | EventStoreDB Cloud | Read Model DB | Total/Month |
|---|---|---|---|---|
| Small | 10M events/month | Starter cluster → ~$180 | db.t3.medium PostgreSQL → ~$60 | **~$240/month** |
| Medium | 100M events/month | Standard cluster → ~$520 | db.r6g.large PostgreSQL → ~$175 | **~$695/month** |
| Large | 1B events/month | Large cluster → ~$1,800 | db.r6g.2xlarge + read replica → ~$700 | **~$2,500/month** |

**Best for:** Teams adopting Event Sourcing for the first time, or teams without deep PostgreSQL operational expertise. The managed replay API, projection engine, and monitoring tooling eliminate 4–6 weeks of infrastructure engineering time. Break-even vs. PostgreSQL self-managed is at approximately 200M events/month.

---

### Option C: AWS DynamoDB Streams + Lambda (Serverless)

Store events in DynamoDB (pay-per-request). Use DynamoDB Streams + Lambda as the projection engine.

**Included:** Serverless scaling, no operational overhead. **Not included:** Full replay (DynamoDB Streams only retains 24 hours — replay requires a full scan), complex query patterns (DynamoDB query limitations require careful key design).

| Tier | Event Volume | DynamoDB | Lambda Projection | Read Model DB | Total/Month |
|---|---|---|---|---|---|
| Small | 10M events/month | ~$15 (on-demand) | ~$5 | ~$60 PostgreSQL | **~$80/month** |
| Medium | 100M events/month | ~$150 (on-demand) | ~$45 | ~$175 PostgreSQL | **~$370/month** |
| Large | 1B events/month | ~$1,500 (on-demand) | ~$400 | ~$700 PostgreSQL | **~$2,600/month** |

**Best for:** Spiky workloads with unpredictable event volume. **Not recommended** as a primary event store if replay is a core requirement — DynamoDB Streams' 24-hour retention means replay always requires a full table scan, which is expensive and operationally fragile. Full replay at 1B events requires scanning the entire table at DynamoDB read capacity unit costs.

---

## Break-Even Analysis

| Comparison | Winner at Low Volume | Winner at High Volume | Crossover Point |
|---|---|---|---|
| EventStoreDB vs. PostgreSQL self-managed | EventStoreDB (includes operational tooling) | PostgreSQL (lower unit cost) | ~200M events/month |
| DynamoDB vs. PostgreSQL | DynamoDB (no idle costs) | PostgreSQL (flat cost, predictable) | ~50M events/month |
| Managed vs. self-hosted (any) | Managed (no ops overhead) | Self-hosted (lower unit cost) | Depends on engineer cost |

**At 10M events/month:** EventStoreDB managed provides the best developer experience at modest premium ($240 vs. $65). The $175/month premium buys the replay API, projection engine, and monitoring — infrastructure that would take 4–6 engineer-weeks to build on PostgreSQL. At a fully-loaded engineer cost of $150/hour, the managed option pays for itself in under 2 weeks of avoided infrastructure work.

**At 1B events/month:** PostgreSQL self-managed is significantly cheaper ($900 vs. $2,500 for EventStoreDB). At this scale the team should have the operational maturity to self-manage. The investment in replay tooling and monitoring is amortized across all event domains.

---

## Hidden Costs

These are the costs that are consistently underestimated in Event Sourcing adoption:

### 1. Long-Term Event Log Storage

Events are immutable. At 1B events/month with an average payload of 1.5 KB, you accumulate:
- Year 1: ~18 TB
- Year 3: ~54 TB
- Year 7 (regulatory retention): ~126 TB

**Mitigation:** Implement a tiered storage strategy from day one:
- Hot (0–90 days): SSD-backed storage for active replay and projection use
- Warm (90 days–2 years): S3 Standard or similar object storage (~$0.023/GB/month vs. ~$0.10/GB for SSD)
- Cold (2–7 years): S3 Glacier Instant Retrieval (~$0.004/GB/month for regulatory archival)

At 126 TB cold storage, the tiered approach saves approximately $12,000/month vs. keeping all events on SSD.

### 2. Replay Compute Spikes

Full replays during backfills or projection migrations spike compute 10–50x over normal projection throughput. A projection that normally uses 0.5 vCPU continuously may require 16 vCPU for 48 hours during a full historical replay.

**Mitigation:** Budget for burst compute capacity (spot instances or reserved burst capacity) separately from steady-state projection compute. Do not run replays on the same compute as live projectors.

### 3. Snapshot Storage Strategy

No snapshot strategy → every aggregate load replays its full event history → query latency grows linearly with aggregate age. A 5-year-old account with daily transactions has ~1,800 events to replay on every load.

Snapshot frequency directly trades storage cost against rehydration latency. Weekly snapshots at 5 KB/aggregate for 1M accounts = 5 GB/week = $0.50/week in S3. Daily snapshots at the same scale = $3.50/week. Monthly snapshots at the same scale = $0.12/week but with up to 30 days of events to replay on cache miss.

### 4. Schema Registry Tooling

Teams that skip a schema registry spend the equivalent cost on incidents. An unvalidated breaking schema change deployed by one team silently corrupts downstream projectors. The investigation and repair cost is measured in engineer-days, not dollars.

Managed schema registry options (Confluent Cloud Schema Registry: ~$50–200/month, AWS Glue Schema Registry: $1/schema version + data access costs) are almost always cheaper than the first production incident they prevent.

---

## Cost Anti-Patterns

### Anti-Pattern 1: Large Payloads in Events

**Problem:** Storing large binary blobs, full document snapshots, or embedding upstream API responses directly in event payloads. A `DocumentSubmitted` event that embeds a 2 MB PDF turns a 200-byte event log into a 2 MB document store.

**Impact:** Storage costs scale by 1000× relative to correctly-designed events. Replay performance degrades. Network costs for projectors increase.

**Fix:** Events should be small (target < 2 KB). Reference large data by ID. Store large artifacts in object storage (S3) and put the object key in the event: `{ "document_id": "doc-123", "s3_key": "docs/doc-123.pdf" }`.

### Anti-Pattern 2: No Snapshot Strategy

**Problem:** Every aggregate load replays from event zero. Works at launch. Becomes a production latency problem after 18 months.

**Impact:** Account load P95 latency grows from 5ms (CRUD) to 800ms (replaying 3 years of events) without a snapshot strategy.

**Fix:** Implement snapshots from day one. Even a simple "snapshot every N events" policy prevents unbounded rehydration latency growth.

### Anti-Pattern 3: Expensive OLAP for Simple Read Models

**Problem:** Projecting events into a data warehouse (Redshift, BigQuery) for queries that a $60/month PostgreSQL read replica would satisfy.

**Impact:** $800–3,000/month for a read model store that provides no query capability benefit over a correctly-indexed PostgreSQL table.

**Fix:** Match the read model store to the query pattern. PostgreSQL handles most OLTP-style read models. Reserve OLAP stores for genuinely analytical queries that require full-table aggregations over billions of rows.

### Anti-Pattern 4: Continuous Full Replays for Projection Bugs

**Problem:** A minor projection bug (e.g., a calculation error in a derived field) triggers a full replay of 3 years of events to rebuild the entire read model.

**Impact:** 48-hour replay jobs consuming $200–500 of burst compute for a bug fix that could have been a targeted SQL correction on the read model.

**Fix:** Design projections to support incremental correction. For simple calculation bugs, an idempotent replay from a known-good checkpoint (rather than event zero) limits both time and cost. For bugs that affect < 1% of records, a targeted read model correction without replay is often appropriate.

---

## Cost Sizing Worksheet

When estimating Event Sourcing infrastructure costs, answer these questions first:

1. **Expected events/day at steady state?** (drives storage and projection compute)
2. **Average event payload size?** (drives storage; target < 2 KB)
3. **Number of distinct aggregate types?** (drives schema registry cost, projection count)
4. **Number of live aggregates?** (drives snapshot storage)
5. **Regulatory retention period?** (drives long-term archival cost)
6. **Replay frequency?** (full replays during projection migrations — drives burst compute)
7. **Query SLOs for read models?** (drives read model store choice)

Answers to these seven questions produce a defensible cost estimate before any infrastructure decisions are made.
