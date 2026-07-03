# AI Integration — Canary Release Pattern

## The Canary Pattern Meets AI Systems

The canary release pattern was designed for stateless services where "correctness" is measurable by error rate and latency. AI systems break both of those assumptions. A model inference endpoint can return HTTP 200 with a plausible-looking response body that is factually wrong, stylistically degraded, or subtly off-distribution. Traditional canary analysis gates — error rate, p95 latency, CPU saturation — will not catch this. The model passed the health check and failed the user.

Adapting canary releases for AI systems requires extending both the analysis gates (what signals constitute success) and the rollback semantics (what happens to users who received degraded responses before rollback). Both are harder than the traditional software case.

---

## 1. Model Version Canary

When a new model version is deployed (fine-tuned checkpoint, upgraded base model, changed system prompt, new inference configuration), the canary analysis gate must measure **output quality**, not just request success.

### The 200 OK Problem

HTTP 200 from a model inference endpoint means the inference server processed the request and returned a response. It does not mean the response was correct, useful, or consistent with the previous model's behavior. A sentiment classifier that begins labeling "positive" as "negative" will return 200 on every request while degrading every downstream decision that depends on it.

**Required additional analysis gates for model version canaries:**

| Traditional gate | What it catches | What it misses |
|---|---|---|
| Error rate | Inference server crashes, timeouts | Incorrect outputs, quality degradation |
| p95 latency | Slow inference, resource contention | Nothing about output quality |
| CPU/memory saturation | Resource regression | Nothing about output quality |
| **Quality gate (required)** | **Accuracy, coherence, safety metrics** | Still misses subtle distributional shift |

### Ground-Truth Evaluation Layer

For a classification model, measuring accuracy during a canary window requires a ground-truth evaluation layer in the analysis pipeline:

```
Request → [Stable model] → Label A
        → [Canary model] → Label B
                       ↓
Ground-truth labels (from human annotation sample or historical confirmed labels)
                       ↓
Accuracy comparison: canary.accuracy vs stable.accuracy
```

This requires either: (a) a subset of requests where the correct answer is known at inference time, (b) a delayed evaluation loop that scores outputs against delayed ground truth (order confirmation, user click, human review), or (c) a proxy quality metric that correlates with actual quality (BLEU score, semantic similarity to a reference output, classifier confidence score).

The important constraint: the ground-truth evaluation must complete within the canary analysis window. If accuracy is measurable only 24 hours after inference (because it requires a user action), it cannot gate a 10-minute canary step. Design the evaluation loop before designing the canary schedule.

---

## 2. Shadow Mode Evaluation

Shadow mode de-risks model version changes by running the new model on 100% of traffic before any user sees its outputs.

```
Client request ──► Stable model ──► Response to user (always)
               └─► Canary model ──► Response discarded (logged for comparison)
```

The canary model receives every request, generates a complete response, and that response is logged but never returned to the user. After a sufficient evaluation period (hours to days, depending on traffic volume and quality requirements), the quality comparison between stable and canary outputs is available without any user having been exposed to the canary model.

### Infrastructure Implications

Shadow mode doubles inference compute during the evaluation period. For GPU-intensive models, this is not a trivial cost:
- A service running 1,000 inference requests/minute against a large language model uses roughly 2× the GPU instance time during shadow mode evaluation
- Shadow responses must be stored for comparison — at typical response sizes, 24 hours of shadow responses for a high-traffic service can require terabytes of storage
- The shadow pipeline must be async — responses must be logged without adding latency to the user-facing request path

Shadow mode is the correct approach for high-risk model changes where even 5% user exposure during a canary window is unacceptable. It is not appropriate as a permanent state — the evaluation period should be time-bounded, after which the team either promotes, rejects, or escalates.

---

## 3. SLO Gates for Model Quality

Quality SLOs for AI systems must be defined with the same rigor as latency SLOs for traditional systems. Vague quality requirements ("the model should be accurate") cannot be evaluated by an automated analysis gate.

### Example Quality SLOs

| Model type | Quality SLO | Measurement method |
|---|---|---|
| Sentiment classifier | Accuracy > 94% on labeled sample | Compare against annotated test set embedded in request stream |
| Summarization model | ROUGE-L score > 0.38 vs reference summaries | Automated scoring against reference corpus |
| RAG / Q&A system | Hallucination detection rate < 2% | LLM-as-judge on a sample of canary outputs |
| Content moderation | False negative rate < 0.5% | Human review sample + automated toxicity classifier |
| Code generation | Compilation success rate > 85% | Execute generated code in sandbox, check exit code |

### AnalysisTemplate with Quality Gates

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: model-canary-analysis
spec:
  metrics:
  # Traditional infrastructure gates
  - name: error-rate
    interval: 2m
    successCondition: result[0] < 0.01
    provider:
      prometheus:
        query: |
          sum(rate(inference_requests_errors_total{version="canary"}[2m]))
          / sum(rate(inference_requests_total{version="canary"}[2m]))

  - name: p95-latency-ms
    interval: 2m
    successCondition: result[0] < 800
    provider:
      prometheus:
        query: |
          histogram_quantile(0.95,
            rate(inference_request_duration_ms_bucket{version="canary"}[2m]))

  # Quality gates — block promotion the same way latency SLOs do
  - name: classifier-accuracy
    interval: 5m
    successCondition: result[0] > 0.94
    provider:
      web:
        url: "http://quality-evaluator.internal/accuracy?version=canary&window=5m"
        jsonPath: "{$.accuracy_score}"

  - name: hallucination-rate
    interval: 5m
    successCondition: result[0] < 0.02
    provider:
      web:
        url: "http://quality-evaluator.internal/hallucination?version=canary&window=5m"
        jsonPath: "{$.rate}"
```

The quality evaluator service is a purpose-built component that consumes logged canary outputs and applies the quality scoring logic. It exposes an HTTP endpoint that the AnalysisTemplate queries — the same mechanism as a custom Prometheus query, but returning quality scores instead of infrastructure metrics.

---

## 4. Rollback Complexity for AI Systems

Reverting a model version is more complex than reverting application code, for three reasons.

**Inference traffic re-routing.** Model inference may be served by a dedicated inference cluster (Triton, vLLM, SageMaker endpoint) that is separate from the application service. Rolling back requires re-routing at both the application layer (stop sending requests to the canary model endpoint) and potentially the inference layer (scale down the canary model replica set). These must happen atomically or users may continue hitting the canary model through a stale route.

**Cached outputs from the canary model.** If the application layer caches model outputs (common for expensive inference calls), cache entries generated during the canary window reflect the canary model's behavior. After rollback, users may receive stale canary-model outputs from the cache even though the system has returned to the stable model. The rollback procedure must include cache invalidation scoped to the canary window: `KEYS inference_cache:* where created_at > canary_start AND created_at < canary_end`.

**User experience inconsistency.** If the canary model served a user for 2 hours with noticeably different behavior (different tone, different level of detail, different classification labels), that user's experience was inconsistent before the rollback occurred. After rollback, the experience changes again. There is no equivalent in traditional software rollbacks — a code rollback is invisible to users if the API contract is stable. A model rollback may be perceptible to users who interacted with the canary model.

This has two implications:
1. For AI systems with user-perceptible behavior differences between model versions, canary windows should be shorter (reducing exposure time) or shadow mode should be used instead.
2. Post-rollback communication may be needed for users who experienced the canary model's behavior for an extended period. This is an AI-specific operational process that has no equivalent in traditional deployment runbooks.

---

## 5. A/B Testing Model Variants

The canary release infrastructure is the correct foundation for model A/B experiments, but the experimental design differs significantly from traditional feature A/B tests.

### Statistical Requirements

Traditional feature A/B tests often use conversion rate as the success metric, which can reach statistical significance in hours to days at sufficient traffic volume. Model quality metrics require:

- **More samples per variant.** Quality metrics (accuracy, coherence, user satisfaction) have higher variance than binary conversion events. Reaching 95% confidence with p < 0.05 may require 10,000+ samples per variant vs. 1,000 for a conversion event.
- **Longer exposure windows.** Models may behave differently across query distributions that emerge over days, not hours. A model that performs well on Monday morning queries may degrade on Wednesday afternoon queries with different vocabulary.
- **Control for distribution shift.** The request distribution to the canary variant must match the stable variant's distribution. If the traffic splitter routes a subset of users who happen to have unusual query patterns to the canary, the comparison is confounded.

### Success Criteria Definition

For a conversion rate A/B test, "better" means higher conversion. For a model A/B test, "better" requires defining the metric — and the right metric is often contested:
- Is accuracy on a labeled test set sufficient, or do you need user satisfaction scores?
- Is a 2% accuracy improvement worth a 15% latency increase?
- How do you weight quality vs. safety in a content moderation model?

These questions must be answered before the canary experiment starts, not after the data comes in. Define the primary success metric and the minimum detectable effect size before routing any traffic to the canary variant. Teams that start an A/B test without pre-specified success criteria will either run the experiment indefinitely ("we need more data") or cherry-pick the metric that shows the result they wanted.

### Infrastructure Additions for AI A/B Testing

| Canary capability | A/B testing addition |
|---|---|
| Traffic splitting by % weight | Traffic splitting by user cohort (consistent hashing ensures a user always hits the same variant) |
| Analysis window (10 minutes) | Minimum exposure period (48-72 hours for quality metrics to reach significance) |
| Pass/fail promotion gate | Statistical significance test: promote only if improvement is significant at p < 0.05 |
| Automated rollback on degradation | Guardrail: auto-stop experiment if quality metric falls below rollback threshold during exposure |
