# AI Integration — CQRS Read Model Projection

## CQRS Read Models Are the Natural Architecture for ML

CQRS read model projections are not adjacent to ML infrastructure — they are architecturally identical to it. A feature store is a read model. Training data is a projection. Feature versioning when a model is retrained is the projection versioning problem. Teams that have built CQRS read model infrastructure have already built the foundational components of an ML platform without necessarily recognizing it.

The fulfillment dashboard projection and the fraud scoring feature store are the same pattern: both consume domain events, apply transformations, and maintain a denormalized, fast-access data structure optimized for a specific consumer. The consumer happens to be a human dashboard in one case and an ML inference endpoint in the other.

---

## 1. ML Feature Store as a Read Model

A feature store is a system that precomputes ML features (inputs to a model) and serves them with low latency at inference time. This is exactly what the CQRS projector does for the fulfillment dashboard: precompute counts and group-by aggregates from raw events and serve them from Redis at 30-second refresh intervals.

The fraud scoring use case:

```
Domain event stream:
  OrderCreated { customer_id, amount, item_count, shipping_address }
  OrderCancelled { customer_id, order_id, reason }
  OrderStatusUpdated { order_id, status, timestamp }

Feature projector (consumes same event stream as fulfillment projector):
  On OrderCreated:
    INCR customer:{id}:order_count_30d
    INCRBY customer:{id}:spend_30d amount
    SET customer:{id}:last_order_ts timestamp
    EXPIRE customer:{id}:* 2592000  # 30 days TTL

  On OrderCancelled:
    INCR customer:{id}:cancel_count_30d

Feature read model (Redis):
  customer:{id}:order_count_30d   → 12
  customer:{id}:spend_30d         → 847.50
  customer:{id}:cancel_count_30d  → 1
  customer:{id}:last_order_ts     → 1748908800
```

At fraud scoring time, the inference service calls the query service for this customer's feature vector — sub-millisecond retrieval from Redis — and passes it to the model. The feature store is populated by the projector consuming the same `orders.events` topic as the fulfillment and history projectors, with a different consumer group and a different projection function.

This architecture does not require a separate feature store product (Feast, Tecton, Hopsworks) at this scale. The projector framework already provides what those products provide — real-time event consumption, feature computation, and fast-access storage — when Redis is available as a read model store.

When a dedicated feature store product is warranted: when the feature computation logic grows complex enough to require a domain-specific abstraction (point-in-time joins across entities, online/offline parity checking, model-specific feature namespacing). At that point, the feature store becomes a consumer of the same event stream, not a replacement for the projector.

---

## 2. Separate Read Models for AI Inference vs. Human UI

The customer order history read model and the fraud scoring feature read model both derive from the same domain events, but their requirements are structurally different:

| Dimension | Customer history read model | Fraud scoring feature read model |
|---|---|---|
| **Access pattern** | Paginated list queries, sort by date, filter by status | Key-value lookup by customer ID, single-key retrieval |
| **Storage backend** | PostgreSQL (supports sort, filter, join) | Redis (sub-millisecond key retrieval) |
| **Schema** | Normalized rows per order, indexed by customer_id and created_at | Hash per customer, computed aggregates, TTL-managed |
| **Data freshness requirement** | Seconds of lag acceptable | Seconds of lag acceptable, but inference latency budget is <10ms total |
| **Size of response** | 20–100 order records per page | 5–15 scalar feature values per customer |
| **Consumer** | Human reading a browser UI | ML model scoring an order for fraud risk |

Building a single read model that serves both consumers produces one read model that is suboptimal for both. The history read model has indexes that make fraud feature retrieval slow; the feature read model has a key structure that makes pagination-based history retrieval awkward.

The projector fan-out to separate read model stores (already established for history, fulfillment, and analytics) extends naturally to a fourth consumer: the inference feature store. The event stream is the common substrate. The consumer determines the storage backend and schema.

---

## 3. Training Data as a Projection

Training datasets for supervised ML models are projections of domain events with computed labels. The `OrderCreated` event plus the eventual `OrderCancelled` or chargeback-dispute downstream event together produce a training example: did this order result in a dispute?

A training projector is a consumer of the same event stream that writes to a data lake instead of an operational store:

```
Training projector (consumes orders.events):
  On OrderCreated:
    Write row to S3 (Parquet):
      {
        "order_id": "...",
        "customer_id": "...",
        "amount": 89.99,
        "item_count": 3,
        "customer_order_count_30d": [from feature read model at event time],
        "customer_spend_30d": [from feature read model at event time],
        "label": null  # populated when dispute event arrives
      }

  On ChargebackDisputeReceived:
    Update Parquet row: label = 1

  On OrderDeliveredConfirmed (no dispute within 90 days):
    Update Parquet row: label = 0
```

The training projector writes event-time feature values (what the feature store looked like when the order was placed) rather than current feature values. This is the point-in-time correctness requirement: training data must reflect what the model would have seen at inference time, not the current value of the feature. This is a known hard problem in feature stores — the CQRS event stream solves it because the event has a timestamp and the event-time feature values can be reconstructed from the feature read model at that timestamp, or better, written into the training record at projection time.

Storage: S3 + Parquet, partitioned by `created_date` and `label`. Typical volume: 1 training record per order. At 10K orders/day, 365 days = 3.65M records, ~200MB as Parquet. Model retraining consumes this via Spark, Athena, or direct S3 Parquet read.

---

## 4. Projection Versioning for Model Retraining

When a fraud model is retrained with a new feature (e.g., adding `customer_distinct_shipping_addresses_30d` as a new feature), the feature store projection must be updated to compute and store this new field. This is the projection versioning problem described in ADR-002, applied directly to ML.

**The analogy:**

| CQRS concept | ML equivalent |
|---|---|
| Projection version v1 | Feature schema v1 (no `distinct_shipping_addresses` field) |
| Projection version v2 | Feature schema v2 (adds `distinct_shipping_addresses` field) |
| Read model migration | Feature store migration: backfill historical features |
| Coexistence of v1 and v2 | Old model uses v1 features; new model uses v2 features; both serve traffic during canary |
| Cutover | Canary completes; old model retired; v1 projector stopped |

**Migration strategy for model retraining:**

1. Define new feature schema (v2) — new projector version computes `distinct_shipping_addresses_30d` from `OrderCreated` events by tracking distinct address hashes per customer.

2. Deploy v2 projector alongside v1 projector (different consumer group, different Redis key namespace: `customer:{id}:v2:*`).

3. v2 projector replays from event history to backfill the new feature for all customers. Replay duration at 1M events: estimated 2–6 hours.

4. New model (trained on v2 feature schema) is deployed in shadow mode, reading from `v2:*` keys. A/B comparison against old model using v1 keys.

5. New model wins canary: traffic shifts to new model. v1 projector is stopped. v1 key namespace is expired via Redis TTL.

This is identical to the read model versioning strategy in ADR-002 and ADR-004. The same tooling — replay controller, lag monitoring, projector framework — serves both operational read model migrations and ML feature store migrations.

---

## 5. Observability Extensions for AI Read Models

The standard projector observability metrics (lag, DLQ depth, processing rate) apply to the feature store projector and training projector. Additional AI-specific signals:

| Metric | Why it matters |
|---|---|
| `feature_store.staleness_ms` by feature name | Feature staleness directly impacts model accuracy; a fraud score based on a 10-minute-old feature is different from one based on a 1-second-old feature |
| `inference.feature_retrieval_latency_ms` | Feature store is on the critical path of fraud scoring; p99 >5ms causes inference latency budget violations |
| `training_projector.label_coverage_pct` | What percentage of training records have a resolved label (0 or 1)? Unlabeled records cannot be used for training; high coverage gap indicates the label-resolution projector is falling behind |
| `feature_store.cache_hit_rate` by feature | If a feature is frequently missing at inference time, the projector is behind or the feature TTL is too short |
| `model_inference.feature_schema_version` | Log which feature schema version each inference request used; required for post-hoc analysis of model decisions and audit of fraud decisions |

---

## Architecture: CQRS Event Stream as the AI Data Backbone

```
                          ┌── Projector (History)    ──► Customer History DB (PostgreSQL)
                          │                                      ↓
                          ├── Projector (Fulfillment) ──► Fulfillment Cache (Redis)
                          │                                      ↓
Orders Event Bus ─────────┤── Projector (Analytics)  ──► Analytics Store (Redshift)
(orders.events)           │                                      ↓
                          ├── Projector (Features)   ──► Feature Store (Redis, v2 namespace)
                          │                                      ↓ (inference time)
                          │                               Fraud Scoring Service → ML Model
                          │
                          └── Projector (Training)   ──► Data Lake (S3 / Parquet)
                                                                 ↓ (batch)
                                                          Model Training → New Model Version
```

The event stream is the single source of truth. Human-facing read models, ML feature stores, and training datasets are all consumers of the same event log. This architecture eliminates the common problem of ML feature definitions drifting from the operational business logic: the feature store projector is subject to the same schema registry, versioning, and replay constraints as the fulfillment dashboard projector. Features cannot silently diverge from the domain model.
