# AI Integration: Feature Flags and Remote Configuration

Feature flag infrastructure provides exactly the primitives needed for safe, controlled AI model deployment. The challenges of deploying a new model version — controlled exposure, rapid rollback, shadow evaluation, parameter tuning without redeployment — map directly onto the flag types and targeting rule capabilities already described in this pattern. This document covers five integration themes.

---

## 1. Model Version Flags

ML model releases follow the same risk pattern as software features: a new model version may perform better on benchmarks but worse on the long tail of production inputs. Progressive delivery — the same 1% → 10% → 100% rollout that manages software release risk — applies directly to model versions.

The four flag types map onto model release patterns:

| Flag Type | Model Release Application |
|-----------|--------------------------|
| **Release** | New model in shadow or canary mode during initial validation (30-day TTL; either promote or revert) |
| **Experiment** | A/B test between model version A and model version B with statistical quality analysis (90-day TTL) |
| **Ops / Kill Switch** | Instant revert to previous model version if quality degrades or safety issue detected (permanent, operational) |
| **Permission** | Per-tenant entitlement to a premium model tier (GPT-4 class vs. smaller open model based on plan) |

**Example release flag definition:**

```json
{
  "key": "inference.model-version",
  "type": "release",
  "description": "Controls which model version handles inference requests. Rolls out model v2 progressively.",
  "variants": {
    "model-v1": { "modelId": "llama-3-8b-instruct-v1", "contextWindow": 8192 },
    "model-v2": { "modelId": "llama-3-8b-instruct-v2", "contextWindow": 16384 }
  },
  "targeting": [
    {
      "rule": "internal-beta",
      "attribute": "tenantId",
      "operator": "in",
      "values": ["tenant_internal_test"],
      "variant": "model-v2"
    },
    {
      "rule": "canary-1pct",
      "operator": "percentageRollout",
      "percentage": 1,
      "variant": "model-v2",
      "hashAttribute": "userId"
    }
  ],
  "defaultVariant": "model-v1",
  "safeDefault": "model-v1",
  "owner": "ml-platform-team",
  "expiresAt": "2026-09-15"
}
```

The `safeDefault: "model-v1"` ensures that if the flag system is unreachable at inference time, the in-process SDK cache returns the stable previous model — not an uninitialized null that crashes the inference service.

---

## 2. Experiment Management for Model Variants

A software A/B test and a model variant experiment share the same infrastructure requirements: controlled cohort assignment, sticky hashing (same user gets same variant across sessions), percentage-based rollout, and evaluation event emission. The difference is the success metric:

| Experiment Type | Assignment Mechanism | Success Metric |
|----------------|---------------------|----------------|
| UI A/B test | Feature flag percentage rollout | Click rate, conversion rate |
| Model variant experiment | Feature flag percentage rollout | BLEU score, task accuracy, human preference rating, latency |

The same flag system that manages a UI experiment can manage a model variant experiment. The flag evaluation determines which model handles the request; the telemetry pipeline must emit model-quality metrics alongside the standard engagement metrics.

**Integration pattern:**

```python
# Evaluate which model variant this request should use
variant = flag_client.evaluate(
    "inference.model-version",
    user_context={"userId": user_id, "tenantId": tenant_id}
)

# Run inference with the assigned model
response = model_registry.get_model(variant["modelId"]).generate(
    prompt=prompt,
    params=variant_params
)

# Emit evaluation event with quality signal
telemetry.emit({
    "flagKey": "inference.model-version",
    "variant": variant["key"],
    "userId": user_id,
    "tenantId": tenant_id,
    "requestId": request_id,
    "qualitySignal": {
        "latencyMs": response.latency_ms,
        "outputTokens": response.output_tokens,
        "userRating": None  # populated async when user feedback arrives
    }
})
```

The evaluation event stream joins with user feedback signals in the analytics platform. The experimentation team analyzes model-quality metrics per variant, not just engagement metrics. This is the same infrastructure used for a UI experiment — the only change is what quality signal is emitted.

**Critical difference from UI experiments:** Model variant experiments must define guardrail metrics. A model that improves task accuracy by 5% but increases latency by 40% or increases harmful output rate is not an improvement. Define explicit guardrails (latency p95 ≤ X, safety classifier fail rate ≤ Y) as automatic stopping conditions before the experiment launches.

---

## 3. Flag-Gated Model Evaluation (Shadow Mode)

Shadow mode is the safest mechanism for validating a new model before any user receives its output. The new model processes live production requests but its responses are discarded — only quality metrics are collected. No user sees the new model's output until shadow validation confirms quality meets the threshold.

**How feature flags enable shadow mode:**

```python
# Evaluate shadow mode flag — this does NOT change what the user sees
shadow_flag = flag_client.evaluate(
    "inference.model-v2-shadow",
    user_context={"userId": user_id}
)

# Always serve with current production model
production_response = model_v1.generate(prompt=prompt)

# If user is in shadow cohort, also run the new model (response discarded)
if shadow_flag.variant == "shadow-enabled":
    shadow_response = model_v2.generate(prompt=prompt)
    
    # Emit shadow evaluation for offline quality analysis
    telemetry.emit_shadow({
        "requestId": request_id,
        "productionVariant": "model-v1",
        "shadowVariant": "model-v2",
        "productionLatencyMs": production_response.latency_ms,
        "shadowLatencyMs": shadow_response.latency_ms,
        "shadowOutput": shadow_response.text,  # NOT returned to user
        "prompt": prompt  # for offline analysis
    })

return production_response  # User always gets production model output
```

Shadow mode flag definition:

```json
{
  "key": "inference.model-v2-shadow",
  "type": "release",
  "description": "Routes a percentage of requests to model-v2 in shadow mode for offline quality assessment. User always receives model-v1 response.",
  "variants": {
    "shadow-disabled": {},
    "shadow-enabled": {}
  },
  "targeting": [
    {
      "rule": "shadow-sample",
      "operator": "percentageRollout",
      "percentage": 10,
      "variant": "shadow-enabled",
      "hashAttribute": "requestId"
    }
  ],
  "defaultVariant": "shadow-disabled",
  "safeDefault": "shadow-disabled",
  "owner": "ml-platform-team",
  "expiresAt": "2026-08-01"
}
```

**Shadow mode infrastructure requirements:** Shadow inference runs in parallel with production inference, adding latency to the request-handling thread. Use async fire-and-forget for shadow calls to avoid increasing user-facing latency. This requires infrastructure that can absorb the additional compute: a shadow inference queue with its own model serving capacity, not sharing production GPU allocation.

**Promotion path:** Shadow mode (10% of requests, user gets production model) → Canary (1% of users get new model, quality monitored) → Progressive rollout (10% → 50% → 100%). The flag type changes from Release to Ops once the rollout is complete and the kill switch is the retained artifact.

---

## 4. AI Feature Kill Switches

When a model produces harmful, biased, or wildly incorrect output in production, the required response must be faster than a code deploy. A kill switch flag that reverts all inference to the previous stable model must be:

- Operable in under 60 seconds by any on-call engineer
- Accessible without deployment pipeline access
- Pre-provisioned (the on-call rotation has the required role before the incident, not during it)
- Accessible to non-engineers: ML Safety team, Legal, Product Safety leads must be able to activate a kill switch without filing a ticket or contacting engineering

Kill switch flag definition:

```json
{
  "key": "inference.model-v2-killswitch",
  "type": "ops",
  "description": "Emergency kill switch: instantly reverts all inference from model-v2 to model-v1. Activate if model-v2 produces harmful, inaccurate, or biased output at scale. Do not require approval — activate first, investigate after.",
  "variants": {
    "active": { "note": "model-v2 is live, normal operation" },
    "killed": { "note": "model-v2 disabled, all traffic to model-v1" }
  },
  "targeting": [],
  "defaultVariant": "active",
  "safeDefault": "killed",
  "owner": "ml-platform-team",
  "killSwitchRoles": ["ml-platform-team", "ml-safety-team", "legal-team", "on-call-engineer"],
  "reviewSchedule": "annual"
}
```

The `safeDefault: "killed"` is intentional: if the flag system is unreachable, fail safe to the known-good model. This inverts the usual safe default (which is typically the stable behavior) — for a kill switch, the safe behavior is the protective action, not the normal operation.

**Kill switch activation playbook:**
1. Activate kill switch via management UI or API (no deployment required, no approvals required)
2. Verify SSE propagation: all SDK instances must receive the update within the 5-second SLO
3. Monitor variant distribution: `inference.model-v2-killswitch.killed` should reach 100% within 30 seconds
4. File post-activation incident ticket (activation comes first; documentation comes after)
5. Conduct model quality investigation before re-enabling

**Testing the kill switch:** Kill switches that have never been tested are not reliable. Test the `inference.model-v2-killswitch` in staging monthly and in production during scheduled maintenance windows. The kill switch test validates the SSE propagation path, not just the flag definition.

---

## 5. Remote Configuration for Model Parameters

Inference parameters (temperature, top-p, max_tokens, system prompt version) control model output character without changing the model itself. Embedding these values in application code or environment variables means every parameter change requires a deployment. Remote configuration allows runtime tuning without redeployment, enabling rapid experimentation on model behavior.

**Remote configuration example for model inference parameters:**

```json
{
  "key": "inference.generation-config",
  "type": "remote-config",
  "schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["temperature", "topP", "maxTokens", "systemPromptVersion"],
    "properties": {
      "temperature": { "type": "number", "minimum": 0.0, "maximum": 2.0 },
      "topP": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
      "maxTokens": { "type": "integer", "minimum": 1, "maximum": 32768 },
      "systemPromptVersion": { "type": "string", "pattern": "^v\\d+$" },
      "repetitionPenalty": { "type": "number", "minimum": 1.0, "maximum": 2.0 }
    },
    "additionalProperties": false
  },
  "currentValue": {
    "temperature": 0.7,
    "topP": 0.95,
    "maxTokens": 2048,
    "systemPromptVersion": "v14",
    "repetitionPenalty": 1.1
  },
  "owner": "ml-platform-team",
  "description": "Inference generation parameters. Changes propagate to all inference service instances within 5 seconds via SSE. Temperature and topP changes are safe to apply at runtime. systemPromptVersion changes are breaking if the prompt contract changes — coordinate with consumers before updating.",
  "lastModified": "2026-06-01T14:22:00Z",
  "changeReason": "Increasing temperature from 0.6 to 0.7 based on experiment FF-EXP-089 showing improved response diversity"
}
```

**Usage in inference service:**

```python
# Remote config is cached in-process — no network call per request
gen_config = config_client.get("inference.generation-config")

response = model.generate(
    prompt=prompt,
    system_prompt=prompt_registry.get(gen_config["systemPromptVersion"]),
    temperature=gen_config["temperature"],
    top_p=gen_config["topP"],
    max_tokens=gen_config["maxTokens"],
    repetition_penalty=gen_config["repetitionPenalty"]
)
```

**What this enables:** The ML team can tune temperature from 0.7 to 0.8 and observe output quality changes across the entire fleet within 5 seconds, with no deployment, no PR, and a full audit trail showing who changed the parameter, when, and why. This is the difference between a multi-hour tuning cycle (change code, PR, review, deploy, observe) and a 5-minute cycle (update config, observe).

**Schema validation is safety-critical:** The JSON Schema definition prevents a parameter update from setting temperature to `"high"` (string instead of float) or maxTokens to `99999` (exceeds model context window). The management API validates all writes against the schema before storage. Invalid parameter updates are rejected at write time, not at inference time where they would cause runtime errors.

**System prompt versioning:** The `systemPromptVersion` field references a separate prompt registry. The remote config carries the version identifier; the prompt content lives in the registry. This separates the runtime tuning concern (which version to use, changeable via remote config) from the content management concern (what the prompt says, managed via the prompt registry with its own review process).
