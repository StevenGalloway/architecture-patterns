# Cost Analysis — CQRS Read Model Projection

## Cost Drivers

CQRS with read model projections replaces one database with multiple specialized stores, adds an event bus, and introduces a projector service between them. Every piece of this architecture has an operational cost that a single-database design does not.

| Dimension | Single-database (baseline) | CQRS with projections |
|---|---|---|
| **Storage** | 1× PostgreSQL (write + reads) | 1× PostgreSQL (write), 1× PostgreSQL or Aurora (history read model), 1× Redis (fulfillment cache), 1× column store (analytics) |
| **Event bus** | None | Kafka, SNS/SQS, or EventBridge |
| **Compute** | Application servers only | Application servers + projector service(s) |
| **Event retention** | None | Events stored long enough to rebuild read models from scratch |
| **Operational overhead** | One database runbook | Projector lag monitoring, replay tooling, schema registry, DLQ management |

---

## Event Bus Options

The event bus is the new infrastructure component that enables CQRS. The choice determines both cost and operational burden.

### Option A: Self-Hosted Kafka (on Kubernetes or EC2)

Full control, lowest per-event cost at scale, highest operational burden.

| Scale | Broker nodes | Storage | Estimate/month |
|---|---|---|---|
| Small (<10K events/day) | 3× t3.medium + 500GB EBS | $150 | ~$300 |
| Medium (100K events/day) | 3× m5.large + 2TB EBS | $350 | ~$650 |
| Large (1M+ events/day) | 6× m5.xlarge + 10TB EBS | $1,200 | ~$2,200 |

Does not include: engineering time (~0.25 FTE for a healthy Kafka cluster), incident response, upgrades. Event retention for 30-day replay at 1M events/day with a 1KB average payload: ~30GB/day × 30 days = 900GB, adding ~$90/month at EBS gp3 pricing.

### Option B: Confluent Cloud (Managed Kafka)

Kafka API-compatible, no cluster operations. Pricing: ~$0.11/GB ingested + $0.11/GB egress + storage.

| Scale | Events/day | Ingested (1KB avg) | Storage (30d) | Estimate/month |
|---|---|---|---|---|
| Small | 10K | 0.3GB | 9GB | **~$8** |
| Medium | 100K | 3GB | 90GB | **~$50** |
| Large | 1M+ | 30GB | 900GB | **~$430** |

Confluent Cloud Basic tier includes 1 environment. Dedicated cluster (required for SLAs) starts at ~$500/month additional. Cost-effective at medium scale without Kafka expertise.

### Option C: AWS SNS + SQS

Per-topic fan-out. SNS publishes to SQS queues, one queue per projector consumer group. No persistent log storage — events are not replayable after SQS visibility timeout (max 14 days).

| Scale | SNS publishes | SQS receives | Estimate/month |
|---|---|---|---|
| Small | 10K/day → 300K/month | 1M receives | **~$1** |
| Medium | 100K/day → 3M/month | 10M receives | **~$4** |
| Large | 1M/day → 30M/month | 100M receives | **~$40** |

Critical limitation: SNS/SQS does not retain events. Replay requires a separate event store (DynamoDB or S3 + Parquet). Add $20–200/month for replay storage depending on volume. Use SNS/SQS when long-term replay is not required (read models can be rebuilt from the write database) or when event volume is low.

### Option D: AWS EventBridge

Serverless event router. $1.00 per million events published. No persistent log. Use for simple fan-out scenarios without ordering guarantees or consumer group management.

| Scale | Events/month | Estimate/month |
|---|---|---|
| Small | 300K | **~$0.30** |
| Medium | 3M | **~$3** |
| Large | 30M | **~$30** |

Same replay limitation as SNS/SQS applies. EventBridge pipes adds per-pipe charges ($0.40/million events) for transformation.

---

## Read Model Store Options

### Option A: Single PostgreSQL with Multiple Schemas

One PostgreSQL instance hosts the write schema, customer history schema, and analytics schema in separate PostgreSQL schemas. Fulfillment dashboard uses a materialized view or Redis remains separate.

| Scale | RDS instance | Estimate/month |
|---|---|---|
| Small | db.t3.medium (2 vCPU, 4GB) | **~$50** |
| Medium | db.r6g.large (2 vCPU, 16GB) | **~$200** |
| Large | db.r6g.2xlarge (8 vCPU, 64GB) | **~$780** |

Simplest to operate. Partially defeats the purpose of CQRS — the read models share I/O with the write model on the same instance. Read-intensive analytics projections will compete with write throughput. Suitable only at small scale or as an initial migration step.

### Option B: Heterogeneous Stores (Recommended)

Separate stores optimized for each read model's access pattern:

| Store | Use case | Estimate/month (medium scale) |
|---|---|---|
| PostgreSQL (write, db.r6g.large) | Write model, normalized | ~$200 |
| PostgreSQL (history, db.r6g.medium) | Customer order history, denormalized, row-access | ~$130 |
| Redis (ElastiCache r7g.large) | Fulfillment dashboard, real-time counts | ~$180 |
| Amazon Redshift (ra3.xlplus) | Analytics, columnar, aggregate queries | ~$380 |
| **Total storage** | | **~$890/month** |

At small scale (development or pre-production), self-hosted PostgreSQL + Redis replaces the managed services at ~$80–120/month total. Use managed services in production for HA and maintenance.

---

## Full Infrastructure Cost Comparison by Scale

### Small (1–3 read models, <10K events/day)

| Component | Choice | Monthly cost |
|---|---|---|
| Event bus | AWS SNS/SQS | $1 |
| Write store | PostgreSQL (RDS t3.micro) | $15 |
| Customer history | PostgreSQL (RDS t3.micro) | $15 |
| Fulfillment cache | Redis (ElastiCache t3.micro) | $15 |
| Analytics | PostgreSQL schema on existing instance | $0 (shared) |
| Projector compute | ECS Fargate (0.5 vCPU, 1GB, 2 tasks) | $20 |
| Replay storage | S3 (10GB event log) | $1 |
| **Total** | | **~$67/month** |

Compare to single-database baseline: ~$30/month (1× RDS t3.micro). CQRS premium at small scale: ~$37/month, or roughly 2.5× the cost. The additional operational complexity is not justified at this scale unless the read/write contention problem is already occurring.

### Medium (3–8 read models, 100K events/day)

| Component | Choice | Monthly cost |
|---|---|---|
| Event bus | Confluent Cloud (Basic) | $50 |
| Write store | PostgreSQL (RDS r6g.large) | $200 |
| Customer history | PostgreSQL (RDS r6g.medium) | $130 |
| Fulfillment cache | Redis (ElastiCache r7g.large, 2-node) | $360 |
| Analytics | Amazon Redshift (ra3.xlplus) | $380 |
| Projector compute | ECS Fargate (1 vCPU, 2GB, 4 tasks) | $125 |
| Replay storage | S3 (90GB Parquet event log) | $2 |
| Schema registry | Confluent Schema Registry (included) | $0 |
| **Total** | | **~$1,247/month** |

Compare to single-database baseline: ~$200/month (1× RDS r6g.large). CQRS premium at medium scale: ~$1,047/month. Justified when read/write contention causes measurable revenue impact (e.g., customer order history timeouts during BI queries, which was the trigger for this implementation).

### Large (8+ read models, 1M+ events/day)

| Component | Choice | Monthly cost |
|---|---|---|
| Event bus | Self-hosted Kafka (6× m5.xlarge) | $2,200 |
| Write store | Aurora PostgreSQL (r6g.2xlarge, Multi-AZ) | $1,100 |
| Customer history | Aurora PostgreSQL (r6g.xlarge, read replica) | $480 |
| Fulfillment cache | Redis (ElastiCache r7g.2xlarge, cluster mode) | $950 |
| Analytics | Amazon Redshift (ra3.4xlarge, 2 nodes) | $3,800 |
| Additional read models (5×) | Varies by type | $500 |
| Projector compute | ECS (16 tasks, varied sizes) | $800 |
| Replay infrastructure | S3 + Glue ETL | $300 |
| Schema registry | Self-hosted or Confluent | $100 |
| **Total** | | **~$10,230/month** |

At this scale, the CQRS infrastructure cost is table stakes. The business cannot serve its read patterns from a single database at this event volume regardless of how much it is tuned.

---

## Hidden Costs

| Cost category | Description | Estimate |
|---|---|---|
| **Event retention for replay** | Storing the full event history to enable read model rebuild from scratch. At 1KB average payload and 1M events/day, 30-day retention = 900GB. S3 Standard: ~$0.023/GB. | ~$21/month per 30 days of retention |
| **Projector catch-up compute** | When a projector is restarted or a new read model is added, it must replay all events from the beginning. At 1M events, catch-up may take hours and spike CPU. Use burstable compute (Fargate with burst) to avoid paying for peak replay capacity in steady state. | ~$50–200 per full replay event |
| **Schema migration tooling** | Managing projection schema versions (v1 → v2 migration) requires tooling to run two projector versions simultaneously, monitor convergence, and cut over. Engineering time: 2–5 days per major schema migration. | ~$3,000–8,000 per migration (eng time) |
| **DLQ management** | Dead-letter queue events require human review and replay decisions. Estimate 30 minutes/week at steady state; 2–4 hours after a deployment incident. | ~2–5 engineer-hours/week |
| **Read model consistency drift debugging** | Eventually consistent reads produce support tickets when customers see stale data. Investigating whether an issue is a projection lag vs. a bug takes time. Invest in lag dashboards to reduce investigation time. | Hard to quantify; plan for 1–2 incidents/quarter initially |

---

## Cost Anti-Patterns

**1. Storing large payloads in events**

Events should carry identifiers and state changes, not full object snapshots. An `OrderCreated` event with a 50KB customer record embedded will cost 50× more to store and transmit than an event that carries only the order ID and changed fields. The projector fetches additional data from the write store if needed. This pattern (event + fetch-if-needed) keeps event storage costs predictable.

**2. Retaining events indefinitely when only 30-day replay is needed**

Event retention is the mechanism for read model rebuild. If a read model can be rebuilt from the write-side PostgreSQL (by replaying the database state rather than the event log), you do not need 365-day event retention. Match retention to the longest expected replay window. 30 days is sufficient for most operational read models.

**3. Projecting into the same database instance as the write model**

Putting all read model schemas on the same PostgreSQL instance as the write model provides logical separation but not physical isolation. Under analytics query load, the same EBS volume I/O limit and memory pool serve both write and read operations. This defeats the primary cost justification for CQRS (isolating write performance from read load) while adding all of the CQRS operational overhead. Use a separate instance.

**4. Running a projector per event type instead of per consumer**

If the fulfillment projector subscribes to `OrderCreated`, `OrderStatusUpdated`, and `OrderCancelled` separately using three different consumer groups, you pay three times for the same event delivery and manage three times the offset state. One consumer group, one projector, one offset per partition is the correct model.
