# ADR-001: Default to Kappa architecture for streaming analytics

## Status
Accepted

## Date
2025-06-18

## Context
The analytics platform was built using Lambda architecture: every business metric was computed by two parallel pipelines, a batch layer (daily Spark jobs on S3 data) and a speed layer (real-time Flink jobs on Kafka events). The batch layer was authoritative; the speed layer provided recent data that would eventually be overwritten by the batch run. The combined view was a union of batch results for older data and speed-layer results for the current day.

After two years in production, three operational problems had accumulated:

**Logic divergence:** The batch and speed pipelines were implemented independently in different codebases (Spark SQL and Flink SQL). As business logic evolved, changes were sometimes applied to one pipeline and not the other, or were applied inconsistently. The daily handover point (midnight) produced visible discontinuities in metrics charts when the batch result replaced the speed layer result with a different number for the same day.

**Double maintenance burden:** Every metric required two implementations, two sets of tests, two deployment pipelines, and two monitoring configurations. For a team of 6 engineers, this overhead consumed approximately 30% of sprint capacity.

**Replay complexity:** When a logic bug was discovered, fixing it required running a new batch job to backfill the corrected values for historical data, then verifying that the batch results matched the fixed speed layer results. Coordinating these two separate systems for a single logical fix was operationally expensive.

The question was not whether streaming or batch was better in general, but whether the complexity of maintaining two parallel systems was justified by the specific benefits of Lambda architecture.

## Decision
Default to **Kappa architecture** (a single streaming pipeline) for new analytics use cases. Lambda architecture (separate batch and speed layers) is used only when there is a specific requirement that Kappa cannot meet.

Criteria for Kappa to be viable:
- Event retention in Kafka is sufficient for the expected replay window (current: 14 days on hot storage, 2 years on S3 archive)
- Stream processing can achieve the required freshness SLO (current: 5-minute end-to-end for operational metrics)
- The processing logic can be expressed as a streaming computation (aggregations, joins, time-windowed operations)

Criteria for Lambda to be preferred:
- The computation requires a full dataset scan that is impractical as a streaming operation (e.g., ML model training on the full event history)
- Event replay from the stream layer would take longer than the acceptable data correction window
- The batch layer produces a fundamentally different computation (e.g., complex multi-pass algorithm) that cannot be approximated in streaming

## Alternatives Considered

**Continue with Lambda architecture, reduce the duplication burden:** Extract shared business logic into a library that both the batch and speed pipelines import. Rejected because even with shared logic, the operational overhead of two separate systems (two deployment pipelines, two monitoring configurations, two sets of runbooks) remains. Logic sharing reduces bugs from divergence but does not reduce the deployment and operational burden.

**Batch-only architecture (eliminate the speed layer):** Remove the real-time speed layer and accept that all metrics are updated daily. Rejected because several operational metrics (real-time inventory levels, same-day order fulfillment tracking) require sub-hourly freshness. Batch-only cannot meet the freshness requirements for these use cases.

**Streaming-only with historical backfill as a special case:** Use streaming for all new computation, but maintain the existing batch pipeline only for historical backfill operations (not for regular production metrics). This is effectively the Kappa approach. The distinction from a pure Kappa approach is that the batch pipeline is retained as an operational tool rather than completely retired; this is the adopted approach.

## Consequences

### Positive
- Single codebase for each metric eliminates logic divergence: there is no batch/speed handover discontinuity because there is only one pipeline
- Sprint capacity freed from double-maintenance work can be redirected to new analytics features
- Replay is a first-class operation of the streaming pipeline (reset the Kafka offset), not a coordination between two separate systems

### Negative
- Kappa requires longer Kafka retention (or S3 archive) than a typical streaming architecture to support replay for historical corrections. The extended retention adds storage costs
- Very long replays (reprocessing 2 years of event data) are slower through a streaming pipeline than through a parallel Spark batch job, which can process the same data in a fraction of the time

### Risks
- **Streaming pipeline downtime causes data gap.** If the Flink job fails and is not restarted within the Kafka retention window, some events are unreplayable from the hot stream (they may be available on S3 archive but at higher replay cost). Mitigation: see ADR-005 for monitoring and alerting that ensures streaming pipeline failures are detected and remediated quickly.

## Review Trigger
Revisit if a new analytics use case requires ML model training or other batch-native computations on the full event history that genuinely cannot be expressed as a streaming computation, at which point a hybrid Lambda approach for that specific use case may be warranted.
