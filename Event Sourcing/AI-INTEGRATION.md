# AI Integration — Event Sourcing Pattern

## Why Event Sourcing and AI Are Natural Partners

Event Sourcing and AI systems share a fundamental requirement: both need a complete, timestamped, immutable record of what happened and why. CRUD systems discard history by overwriting state. Event-sourced systems preserve it by design. This makes the event log a first-class asset for AI training, explainability, and agent coordination — not an afterthought.

The patterns below represent the most significant integration points between Event Sourcing architecture and AI/ML workloads. Each has direct implementation implications.

---

## Theme 1: Audit Trail for AI Decisions

**The regulatory explainability requirement**

Every AI action — model prediction, recommendation, automated decision — is sourced as an event with full context. This is the architectural foundation for GDPR Article 22 (right to explanation) and emerging AI governance regulations.

A `LoanDecisionMade` event sourced at decision time:

```json
{
  "event_id": "evt-7f3a8b2c",
  "event_type": "LoanDecisionMade",
  "event_version": 2,
  "aggregate_id": "application-88421",
  "aggregate_version": 3,
  "occurred_at": "2025-11-14T09:23:45.123Z",
  "payload": {
    "decision": "denied",
    "model_version": "credit-risk-v2.3",
    "model_registry_ref": "mlflow://models/credit-risk/23",
    "input_features_hash": "sha256:abc123def456",
    "confidence_score": 0.87,
    "top_factors": [
      { "feature": "debt_to_income_ratio", "contribution": 0.41, "direction": "negative" },
      { "feature": "recent_credit_inquiries", "contribution": 0.28, "direction": "negative" },
      { "feature": "account_age_months", "contribution": 0.18, "direction": "negative" }
    ],
    "decision_latency_ms": 23,
    "reviewer_id": null,
    "override_reason": null
  }
}
```

This event answers "why was this decision made?" years after the fact — without requiring the original model to still be deployed. The `input_features_hash` allows retrieval of the exact feature vector from a separate feature store. The `model_registry_ref` points to the exact model artifact.

**Implementation note:** Store the hash of input features, not the features themselves, in the event (features may contain PII subject to erasure). Store the raw features in an encrypted feature store keyed by the hash. On erasure, delete the feature store entry — the event remains intact but the features are irrecoverable.

---

## Theme 2: Event Replay for Model Retraining

**The event log as a self-contained training dataset**

The complete event history is a labeled dataset. Every business outcome that was recorded as an event is a training label. Every sequence of events leading up to that outcome is a feature sequence.

**Without Event Sourcing:**
- Historical training data lives in a data warehouse loaded by ETL jobs
- ETL jobs apply transformations that may not match the transformations the model used at inference time (training-serving skew)
- Retraining on corrected labels requires re-running ETL over the entire history

**With Event Sourcing:**
- Replay events through a feature extraction function to generate training data
- The same feature extraction function used for training can be deployed for inference (eliminating training-serving skew)
- When a model is retrained on corrected labels, replay the same events through a new feature extractor — no separate data pipeline

```
Event Log → Feature Extractor V1 → Training Dataset V1 → Model V1
Event Log → Feature Extractor V2 → Training Dataset V2 → Model V2
```

The event log is the single source of truth. Model retraining does not require coordination with a data engineering team to re-run ETL — it requires defining a new projection of the existing event log.

**Practical guidance:**
- Version feature extractors the same way you version projections (see Theme 5)
- Store the feature extractor version alongside the model version in the `LoanDecisionMade` event
- Maintain at least 90 days of events in hot storage for rapid experimentation (model teams should not need ops support to replay 3 months of training data)

---

## Theme 3: AI Action Sourcing in Agentic Systems

**Events as the foundation for autonomous agent rollback**

In agentic AI systems, an AI agent takes sequences of actions to achieve a goal. Some of those actions will be wrong. The architectural requirement is the ability to roll back a sequence of bad actions and resume from a checkpoint before the error occurred.

Event Sourcing provides this natively: every action taken by an AI agent is an event. The aggregate is the agent's task context. Rollback is replay from a prior event version.

```
AgentTaskStarted         → aggregate_version: 1
FileAnalysisCompleted    → aggregate_version: 2
CodeChangeProposed       → aggregate_version: 3
CodeChangeApplied        → aggregate_version: 4   ← bad decision
TestRunFailed            → aggregate_version: 5
RollbackRequested        → aggregate_version: 6   ← "undo" from here
```

A `RollbackRequested` event is itself an event. The aggregate rehydrates to the state at version 3 (before `CodeChangeApplied`). This is not a delete operation — the bad action remains in the event history as evidence. The rollback is a compensating action, not a history rewrite.

**Why this matters at scale:** Without event sourcing for agent actions, autonomous agent systems have no reliable undo mechanism. The agent either completes successfully or requires human intervention to determine what state it left the system in. With Event Sourcing, the agent's full action history is queryable, auditable, and replayable.

**Design guidance for agentic events:**
- Every external action (API call, file write, database mutation) must be preceded by a `*Proposed` event and followed by either a `*Applied` or `*Failed` event
- The `*Proposed` event records the agent's reasoning (why it chose this action) — this is the explanation payload
- Human approval gates can be modeled as `*ApprovalRequested` → `*ApprovalGranted`/`*ApprovalDenied` events before the `*Applied` event

---

## Theme 4: Temporal Queries for Model Drift Detection

**Querying what the model predicted, when**

Model drift detection requires comparing a model's current behavior to its historical behavior on similar inputs. Without event sourcing, this comparison is impossible: the predictions were never stored, or were stored only in application logs that are not structured for efficient query.

With Event Sourcing and the `LoanDecisionMade` event schema above, temporal queries become first-class:

```sql
-- What was the denial rate for applications with debt_to_income > 0.4 in Q3 2024?
SELECT
  date_trunc('week', occurred_at) as week,
  count(*) filter (where payload->>'decision' = 'denied') as denials,
  count(*) as total,
  avg((payload->>'confidence_score')::float) as avg_confidence
FROM events
WHERE event_type = 'LoanDecisionMade'
  AND occurred_at BETWEEN '2024-07-01' AND '2024-09-30'
  AND payload->'top_factors' @> '[{"feature": "debt_to_income_ratio"}]'
GROUP BY 1
ORDER BY 1;
```

This query is possible because the decision event preserves the model version, confidence score, and contributing factors at the moment of the decision. A projection over this data produces a model performance dashboard without requiring any additional logging infrastructure.

**Projection for drift monitoring:** Create a dedicated `model_performance` read model that projects `LoanDecisionMade` events into weekly cohorts. When model V2.3 shows a drift in average confidence score vs. V2.2 on the same feature distributions, the read model surfaces it before the drift produces measurable business impact (loan default rate change).

---

## Theme 5: Projection Versioning Maps to Model Versioning

**The structural equivalence between projection migrations and model upgrades**

When a new model version is deployed, the downstream read models (performance dashboards, approval rate metrics, risk cohort analyses) may need to be rebuilt using the new model's feature definitions. This is identical to deploying a new projection version after an event schema change.

```
Event Log + Feature Extractor V1 = Read Model V1  (supports Model V1 queries)
Event Log + Feature Extractor V2 = Read Model V2  (supports Model V2 queries)
```

The migration path is the same as any projection migration:
1. Deploy the new feature extractor as a new projector (runs alongside the old one)
2. Replay historical events through the new feature extractor to backfill the new read model
3. When the new read model is complete, cut query traffic over
4. Keep the old read model for comparison queries during model validation

**Operational benefit:** ML teams can validate a new model's performance against historical data without deploying the model to production — they replay events through the new feature extractor, build the backfilled read model, and run offline evaluation. The production model is unchanged until the evaluation passes.

This is the architectural pattern that enables true A/B model comparison: both models project the same event log, producing two read models that can be queried side-by-side.

---

## Integration Architecture

```
                    ┌─────────────────────────────────────┐
                    │         Event Store                  │
                    │  (immutable business event log)      │
                    └────────────────┬────────────────────┘
                                     │
               ┌─────────────────────┼──────────────────────┐
               ▼                     ▼                      ▼
    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │  Feature         │  │  Model Decision  │  │  Agent Action    │
    │  Extractor V2    │  │  Projection      │  │  Projection      │
    │  (training data) │  │  (AI audit trail)│  │  (agent context) │
    └──────────────────┘  └──────────────────┘  └──────────────────┘
               │                     │                      │
               ▼                     ▼                      ▼
    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │  ML Training     │  │  Explainability  │  │  Agent Rollback  │
    │  Dataset V2      │  │  API             │  │  / Undo API      │
    └──────────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Governance and Compliance Notes

- AI decision events should be retained for the same duration as the business transaction they relate to (e.g., 7 years for financial decisions), not just ML experiment retention windows
- The `model_version` and `model_registry_ref` in AI decision events must point to an artifact that is itself retained — model artifacts cannot be deleted if their decisions are still within the retention window
- Regulatory AI explainability requirements (EU AI Act, CFPB fair lending) are most cleanly satisfied by an event-sourced audit trail that captures the full decision context at decision time — retroactive explanation from a model that may have since been retrained is not compliant
