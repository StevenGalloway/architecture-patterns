# AI Integration — Data Mesh Pattern

## Data Mesh as the Foundation for Enterprise AI

Machine learning systems have the same structural problem as analytics systems: the teams who understand the data (domain teams) are separated from the teams who build the systems that use it (ML teams). In a centralized data model, ML teams file requests for training data and wait. In a Data Mesh, ML features, training datasets, and inference outputs are first-class data products owned by domain teams — and the mesh's governance, lineage, and contract infrastructure applies directly to AI assets.

This is not a metaphor. The same `data-product.yaml` manifest, the same catalog, the same CI quality gate, and the same lineage service that govern analytical data products govern ML features and training datasets. AI governance becomes a natural extension of data governance, not a separate system.

---

## 1. AI Feature Stores as Data Products

ML features — user embeddings, product vectors, behavioral signals, propensity scores — are data products in the mesh. They are owned by domain teams, versioned, contracted, and consumed by ML model training pipelines and inference services just like any other data product.

**Ownership boundary:**
- The ML Platform team owns the feature store infrastructure (Feast, Tecton, or AWS SageMaker Feature Store as a platform service)
- Domain teams own the features relevant to their domain: the Recommendations domain owns item embeddings and item-item similarity vectors; the User domain owns user behavioral features and engagement signals; the Orders domain owns purchase frequency and basket composition features

This follows the same principle as data product ownership: the team with domain knowledge owns the feature, because they know what signals are meaningful and how edge cases should be handled.

**Feature store data product contract:**

```yaml
feature_store_product:
  name: user_purchase_propensity_features
  domain: user
  owner: user-ml@company.com
  classification: internal
  feature_group: user_behavioral
  features:
    - name: days_since_last_purchase
      dtype: float32
      pii_classification: pii_indirect
      description: Days elapsed since the user's most recent completed order
    - name: purchase_frequency_30d
      dtype: float32
      pii_classification: pii_indirect
      description: Number of orders placed in the trailing 30-day window
    - name: avg_order_value_90d
      dtype: float32
      pii_classification: pii_indirect
      description: Mean order value in the trailing 90-day window, in USD
  refresh_cadence: hourly
  staleness_slo_minutes: 90
  serving_latency_p99_ms: 50
  consumers:
    - recommendations-ml-team
    - personalization-ml-team
  version: "2.1.0"
  changelog: "v2.1.0: Added avg_order_value_90d; deprecated basket_size_30d (see v3 migration guide)"
```

The `staleness_slo_minutes` field is unique to feature stores — a feature that is too stale at serving time can degrade model quality in ways that are difficult to detect without explicit SLO monitoring.

---

## 2. Training Data as a Data Product

Labeled datasets and training corpora are first-class data products in the mesh. They have owners, quality SLAs, lineage tracking, and access contracts — the same as any analytical data product.

**Who owns what:**

| Training Dataset | Owning Domain | Consumers |
|---|---|---|
| Labeled customer support tickets (for support classifier) | Customer Experience domain | ML team building support routing model |
| Product image labels (for visual search) | Catalog domain | Search ML team |
| Fraud-labeled transactions (for fraud model) | Risk domain | Risk ML team |
| User click-through labels (for ranking model) | Recommendations domain | Recommendations ML team |

The Customer Experience domain owns the labeled support ticket dataset because they have the business context to know what "correctly labeled" means, they have the subject matter experts who do the labeling, and they know when the label taxonomy needs to evolve.

**Why this matters for model quality:**

The "nobody knows where this training data came from" problem is a leading cause of silent model degradation. When a fraud model's training dataset is a CSV that someone exported two years ago from a system that no longer exists, and the model starts degrading, there is no way to know whether the degradation is caused by distribution shift in production data or staleness of the training data.

A training dataset as a data product has:
- Lineage to its source data products (traceable to raw operational data)
- A quality SLO (completeness, label accuracy rate, class distribution drift alert)
- A refresh cadence (training data is not a static artifact — it gets updated as new examples arrive and as the label taxonomy evolves)
- A version history (model v3.2 was trained on training-data v1.8; you can reproduce it)

---

## 3. Federated Model Governance

Just as the mesh federates data governance (central standards, domain enforcement via CI gate), model governance follows the same pattern.

**Central standards (Platform / Governance Council defines):**
- Which data products are permitted to be used for training which categories of models (e.g., user behavioral data cannot be used to train models that make high-stakes decisions — credit, employment, housing — without a privacy review)
- Minimum training data freshness requirements by model tier (real-time models: training data must be refreshed weekly; batch models: monthly acceptable)
- Bias evaluation requirements for models trained on demographic-adjacent features
- Model card format requirement before any model is promoted to production

**Domain enforcement:**
- Domain teams enforce these policies for their own models during CI/CD
- A model that was trained on a data product classified as `restricted` without explicit governance review cannot be promoted to production (CI gate blocks it)
- The ML Platform team's CI integration checks that training data lineage is recorded before a model artifact is published

This mirrors the federated governance pillar exactly. The platform sets the fence; domain teams operate inside it.

---

## 4. AI Lineage: Extending OpenLineage for Model Training

Tracking which training data produced which model version is an extension of the lineage infrastructure the mesh already provides. OpenLineage's `DatasetFacet` can be extended to include model training events.

**Standard OpenLineage event (data transformation):**

```json
{
  "eventType": "COMPLETE",
  "job": { "namespace": "orders", "name": "orders_daily_revenue" },
  "inputs": [{ "namespace": "orders", "name": "orders_raw" }],
  "outputs": [{ "namespace": "orders", "name": "orders_daily_revenue" }]
}
```

**Extended event for model training (custom `TrainingRunFacet`):**

```json
{
  "eventType": "COMPLETE",
  "job": { "namespace": "recommendations-ml", "name": "ranking_model_train_v3_2" },
  "inputs": [
    { "namespace": "recommendations", "name": "click_through_labels_v1_8" },
    { "namespace": "user", "name": "user_purchase_propensity_features_v2_1" },
    { "namespace": "catalog", "name": "item_embeddings_v4_0" }
  ],
  "outputs": [
    { "namespace": "recommendations-ml", "name": "ranking_model_artifact" }
  ],
  "run": {
    "facets": {
      "trainingRun": {
        "_producer": "recommendations-ml/training-pipeline",
        "modelVersion": "3.2.1",
        "framework": "PyTorch 2.1",
        "trainingDataSnapshot": "2025-11-01T00:00:00Z",
        "evalMetrics": {
          "ndcg_at_10": 0.412,
          "mrr": 0.318
        }
      }
    }
  }
}
```

Marquez and platforms like Egeria support custom facets. This means the lineage query `"which training datasets does ranking_model v3.2 depend on?"` is the same graph traversal query used for GDPR erasure — the infrastructure is shared.

**GDPR implication:** If a user requests erasure, the lineage graph must trace not only which analytical data products contain their records, but also which ML models were trained on data including their records. This is the emerging requirement of GDPR Art. 17 as applied to AI systems, and Data Mesh's lineage infrastructure is the mechanism that makes it tractable.

---

## 5. Domain-Owned Model Serving

In a mature mesh, domain teams own not just their data products but their inference endpoints. The platform team provides the serving infrastructure; domain teams own the models and their deployment.

**Ownership model:**

| Component | Owner |
|---|---|
| Model serving infrastructure (Triton, BentoML, SageMaker endpoints) | ML Platform team (platform service) |
| Model artifact (trained weights, serialized model) | Domain ML team |
| Inference endpoint deployment configuration | Domain ML team |
| Serving SLO (p99 latency, availability) | Domain ML team |
| Serving infrastructure scaling and reliability | ML Platform team |

This is X-as-a-service: the ML Platform team provides the deployment pipeline and scaling infrastructure as a platform capability. The Recommendations domain owns the ranking model, writes the deployment configuration, declares the serving SLO, and is on-call for model quality incidents. The platform is on-call for serving infrastructure failures.

**Serving data product contract:**

```yaml
inference_product:
  name: recommendations_ranking_model
  domain: recommendations
  owner: recommendations-ml@company.com
  model_version: "3.2.1"
  serving_endpoint: https://inference.internal/recommendations/ranking/v3
  slo:
    latency_p99_ms: 120
    availability_pct: 99.9
  input_schema: schemas/ranking_request.json
  output_schema: schemas/ranking_response.json
  training_data_lineage: recommendations-ml/ranking_model_train_v3_2
  refresh_cadence: weekly_retrain
  consumers:
    - homepage-service
    - search-service
```

The `training_data_lineage` field links the serving endpoint back to the training run, which links back to the training datasets. The full provenance chain — from raw operational data to model prediction — is captured in the mesh's lineage infrastructure.
