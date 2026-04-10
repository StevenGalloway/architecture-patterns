# ADR-004: Define targeting rule evaluation order for deterministic, sticky rollouts

## Status
Accepted

## Date
2026-02-19

## Context
The targeting rule model determines how the SDK assigns a variant to a given user context. Several real requirements drove the design:

**Per-tenant overrides.** Enterprise customers on the Professional plan must have certain features enabled that are not yet in general availability. The billing team needs to activate a flag for a specific tenant ID without affecting any other tenant. If the percentage rollout for a flag is at 20%, a Professional tenant should always get the feature regardless of whether they fall in the 20%.

**Sticky percentage rollouts.** A product experiment is running at 10% exposure. A user who gets the "variant" version on Monday must get the same version on Tuesday — if the user flips between variants on subsequent requests, measured metrics (conversion, engagement) are meaningless. Stickiness must be per-user, not per-session, and must be derived deterministically without storing per-user state.

**Rule conflict resolution.** An early prototype of the targeting engine used a "most specific rule wins" heuristic. During QA, a tester found a case where a user was both in a named cohort ("beta_users") and in the percentage rollout. Depending on which rule was considered "more specific," the user got different variants. The prototype had no documented precedence — two engineers disagreed on the expected behavior, and both were right according to different mental models.

## Decision
Rules are evaluated in strict priority order; the **first matching rule wins** and evaluation stops:

1. **Explicit override** — specific `userId` or `tenantId` listed directly in the flag's override list
2. **Tenant rule** — match on `tenantId` or `planTier` (e.g., all Professional tenants)
3. **Cohort/segment rule** — match on a named user attribute (e.g., `beta_user: true`, `region: "eu"`)
4. **Percentage rollout** — deterministic hash: `parseInt(sha256(flagKey + ':' + userId).slice(0, 8), 16) % 100 < percentage`
5. **Environment default** — a per-environment default value (e.g., dev/staging always-on)
6. **Global default** — the flag's `safeDefault` value

**Percentage hash design:**
- The flag key is included as a hash salt so the same user does not always fall in the same percentile across all flags. Without this, a user in the "bottom 10%" of the hash space would be in the 10% cohort for every flag simultaneously — meaning percentage rollouts across flags would not be independent.
- The hash is deterministic given a fixed `flagKey` and `userId`, providing natural stickiness without storing per-user state.
- A user at percentile 9 (in the 10% cohort) remains in the cohort when the flag is ramped to 20% — cohort membership only grows as percentage increases, it never shrinks for users who were previously included.

**Tenant override implementation:** Tenant rules match on exact `tenantId` or on a `planTier` string. A flag can have multiple tenant rules (e.g., rule 1: tenantId IN ["acme-corp", "globex"] → true; rule 2: planTier = "professional" → true). Each rule has its own value, allowing different overrides for different tenant criteria.

## Alternatives Considered

**"Most specific rule wins" precedence:** Evaluate all rules, apply the most specific one (explicit overrides are more specific than tenant rules, which are more specific than percentage). Rejected because "specificity" is ambiguous when a user matches both a cohort rule and a percentage rule — the definition of "more specific" becomes a judgment call that different engineers will implement differently.

**Separate flag per tenant override:** Instead of targeting rules within a flag, maintain separate flag definitions per tenant (e.g., `checkout-v2` and `checkout-v2:acme-corp`). The SDK merges them at evaluation time. Rejected because it creates flag proliferation — a flag with 50 tenant overrides becomes 50 separate flag definitions, making the registry unmaintainable and staleness tracking much harder.

**Server-side state for stickiness (per-user variant assignment stored in Redis):** When a user first evaluates a percentage flag, record their assigned variant in Redis. On subsequent evaluations, return the stored variant. Provides perfect stickiness. Rejected because: (1) adds a Redis read to every flag evaluation, defeating the sub-millisecond local evaluation goal; (2) requires a cleanup strategy (how long to retain per-user assignments?); (3) deterministic hash achieves the same stickiness property without storage overhead.

## Consequences

### Positive
- Deterministic: same user + same context + same flag state = same variant on every evaluation, with no stored state required
- Sticky: percentage hash is based on `userId`, not session or timestamp, so users don't flip variants between requests
- Predictable rule precedence with no ambiguity — the evaluation order is documented and is the only implementation
- Per-tenant overrides supported without separate flag definitions per tenant

### Negative
- Complex rule sets (5+ rules on a single flag) require a preview/dry-run API to validate before applying; without it, engineers can't easily predict which rule will match for a given user context
- The evaluation order must be documented in the SDK's README and in onboarding materials — it's not obvious from the flag definition itself
- Percentage cohort monotonicity (users in 10% stay in 20% when ramped) can cause A/B experiment bias if the 10% cohort is not representative; this is a property of hash-based assignment that product teams need to understand before designing experiments

### Risks
- **Rule precedence not understood by flag creators.** An engineer adds a cohort rule intending it to take priority over a percentage rollout, but the percentage rule evaluates first if the user is not in the cohort. They see unexpected behavior and assume the SDK is buggy. Mitigation: the management API UI and CLI both show a "what would this user get?" preview tool. Flag documentation includes a clear precedence table. Evaluation events log the `ruleMatched` field for debugging.

## Review Trigger
Revisit if A/B experimentation requirements grow to need more sophisticated assignment (e.g., stratified sampling, CUPED variance reduction) — at that point a dedicated experimentation platform (Eppo, Statsig) may be warranted rather than extending the flag system's targeting engine.
