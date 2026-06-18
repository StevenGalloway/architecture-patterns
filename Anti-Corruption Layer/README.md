# Anti-Corruption Layer (ACL) Pattern

## Summary
An **Anti-Corruption Layer (ACL)** is an integration boundary that **protects your core domain** from the models, semantics, and volatility of external systems (vendors, legacy platforms, ERPs, CRMs).

Instead of importing an external model directly, the ACL:
- translates external contracts into **internal canonical/domain models**,
- isolates “weirdness” (naming, types, status codes, nullability, identifiers),
- provides resilience (retries, fallbacks, circuit breakers),
- enables contract testing and controlled change management.

This pattern is especially common in enterprise modernization, M&A integration, and vendor platforms where external changes are outside your control.

---

## Problem
Directly integrating external systems often causes:
- the external model to “leak” into your core domain,
- widespread refactors when the vendor changes fields or semantics,
- inconsistent mappings scattered across services,
- brittle integrations and production incidents when payloads drift.

---

## Constraints & Forces
- Vendor APIs evolve on their schedule; changes may be undocumented or late-notified
- Data quality issues (missing fields, inconsistent IDs, non-standard enums)
- Performance constraints (vendor latency, throttling, outages)
- Compliance constraints (PII handling, auditability)
- Need for internal stability and domain correctness

---

## Solution
Create an **ACL Adapter** between your core domain and the external system:

**Core Domain → (Canonical Model) → ACL Adapter → Vendor System**

Responsibilities of the ACL:
1. **Translation**
   - map vendor DTOs to internal canonical/domain models
   - normalize types, enums, IDs, dates, optional fields
2. **Policy enforcement**
   - validate required fields
   - enforce internal invariants at the boundary (not business rules deep in domain)
3. **Resilience**
   - timeouts, retries (idempotent reads), circuit breakers
   - caching where appropriate
4. **Contract management**
   - contract tests against vendor schema
   - versioned mappings and migration strategy
5. **Observability**
   - structured logs, metrics, tracing with correlation IDs

---

## When to Use
- Integrating with vendor/legacy systems with unstable or poor domain modeling
- You need to insulate internal systems from external churn
- You have multiple internal consumers and want consistent mapping and governance
- You need compliance controls at integration boundaries

---

## When Not to Use
- You control both systems and they share a bounded context
- The external contract is stable and identical to your domain model (rare)
- Overhead is not justified for a small one-off integration

---

## Tradeoffs
### Benefits
- Domain purity and stability
- Faster internal evolution; external changes localized
- Better testability and observability of integrations
- Centralized governance for vendor mappings

### Costs / Risks
- Extra component and mapping work
- Risk of ACL becoming a “dumping ground” if scope is not controlled
- Need for strong versioning and change management discipline

---

## Failure Modes & Mitigations
1. **Vendor payload drift breaks mapping**
   - Mitigation: schema validation + contract tests + feature flags for mapping versions
2. **Vendor outages / throttling**
   - Mitigation: caching, circuit breaker, fallback paths, bulkheads
3. **Silent semantic changes (field meaning changes)**
   - Mitigation: data quality checks, monitoring for distribution shifts, alerts
4. **Inconsistent mapping implementations across teams**
   - Mitigation: central ACL ownership and shared canonical model definitions
5. **ACL grows business logic**
   - Mitigation: keep ACL limited to translation + boundary validation + resilience

---

## Security Considerations

The ACL is a trust boundary between two different trust domains: the external vendor (untrusted) and the internal core domain (trusted). The core risk is that a failure in translation can carry a threat from the untrusted domain directly into the trusted domain — dressed in the domain's own language.

**Key controls at the ACL boundary:**
- All vendor-supplied content must be treated as untrusted input, regardless of vendor reputation. A compromised vendor account or vendor-side vulnerability can inject malicious payloads.
- Output allowlisting rather than field exclusion: map only fields that consuming services have a documented need for. New vendor fields that are not on the allowlist are silently dropped, preventing accidental PII propagation.
- Security-relevant fields (account status, role, entitlement flags) require strict schema validation — missing or wrong-typed values are rejected, not defaulted to an "allow" state.
- Vendor credentials must never appear in application configuration files, environment variable definitions in container specs, or source code. Fetch from AWS Secrets Manager or HashiCorp Vault at runtime.
- Network policy must prevent domain services from calling vendor APIs directly. ACL bypass is a critical security control failure — it defeats all boundary protections simultaneously.

**Compliance relevance:** GDPR Article 5 (data minimization enforced structurally at the ACL), GDPR Article 28 (vendor as data processor — ACL is the boundary), SOC 2 CC6.1 (vendor access audit log), PCI DSS Requirement 1 (network segmentation at ACL boundary).

→ See [SECURITY.md](SECURITY.md) for the full threat model, attack surface table, vendor credential management requirements, PII handling controls, ACL bypass detection, and the pre-deployment security checklist.

---

## Observability Considerations

The ACL is the only point of visibility into vendor health and translation quality. Without observability here, vendor latency spikes, rate limit exhaustion, and silent schema drift all become invisible until they produce downstream domain errors.

**Golden signals for the ACL:**
- **Latency:** Track `acl.vendor_call.latency.p95` separately from `acl.translation.latency.p95`. A growing translation latency indicates schema complexity growth or a translation logic regression — not vendor slowness.
- **Traffic:** Monitor `acl.cache.hit_rate` continuously. A sudden drop in cache hit rate signals a new request pattern or a TTL misconfiguration that is generating unexpected vendor API load.
- **Errors:** Schema validation failure rate is the most critical ACL-specific metric. Any non-zero rate means the vendor has changed their API without notice. Zero tolerance: any validation failure triggers a notification within 5 minutes.
- **Saturation:** Circuit breaker state per vendor is a leading indicator of vendor health. Time in half-open state (vendor partially recovering) is often the most useful operational signal during incidents.

**SLO targets (reference):** 99.5% translation availability (dependent on vendor uptime), 99.9% schema validity rate (validation failure rate < 0.1%), 99% of translations complete in under 50ms (excluding vendor call latency).

**Structured log** emitted for every vendor call: `vendor`, `vendor_endpoint`, `vendor_api_version`, `consumer_service`, `cache_hit`, `vendor_latency_ms`, `translation_latency_ms`, `validation_result`, `circuit_breaker_state`, `status`. No PII field values in logs.

→ See [OBSERVABILITY.md](OBSERVABILITY.md) for the full golden signals reference, SLI/SLO definitions, structured log schema, dashboard designs, and 7 chaos engineering test scenarios with pass criteria.

---

## Team Topology

The ACL's ownership model determines whether it protects the domain or becomes a bottleneck to it. The recommended model for organizations with three or more vendor integrations is the platform + domain split: the platform team provides the ACL runtime (HTTP client, circuit breaker, schema validation, credential injection, observability pipeline), and the domain-owning team is responsible for the correctness of the canonical model mappings for their domain.

Conway's Law produces the most common ACL failure: six teams, six vendor integrations, six inconsistent canonical models. The same external entity (`customer`) ends up as `CustomerId`, `accountId`, and `clientRef` in three different domain services — all referring to the same vendor entity. The architectural cure is organizational: a shared canonical model governed by one team, with contribution rights granted to consuming teams.

The stealthiest failure mode is bypass: when the ACL team is slow, stream-aligned teams call vendor APIs directly, and the bypass goes undetected because the ACL never sees those calls. Make bypass detectable (network policy + vendor audit log comparison) and make the ACL faster to use than bypassing it.

→ See [TEAM-TOPOLOGY.md](TEAM-TOPOLOGY.md) for the three ownership models, Conway's Law implications, team interaction modes, bypass detection, and the scaling model from Stage 1 through Stage 3.

---

## Cost Analysis

The dominant cost of the ACL is not infrastructure — it is mapping maintenance. Every vendor schema change requires updating translation functions, updating contract test fixtures, and deploying. Enterprise vendors change their APIs 2–6 times per year. With five vendors, this is 40–240 engineering hours per year at a blended engineering cost.

| Configuration | Infrastructure cost/month | Notes |
|---|---|---|
| Embedded library (1 vendor, 1 consumer) | ~$50 | No separate service; maintenance cost multiplies with consumers |
| Dedicated ACL service (1–3 vendors, low volume) | ~$95 | Shared circuit breaker + cache; maintenance is centralized |
| Dedicated ACL service (5+ vendors, 10M calls/day) | ~$760–$1,200 | Engineering maintenance exceeds all infrastructure costs |

The break-even for a dedicated ACL service vs. embedded library is approximately 2–3 consuming teams. Beyond that, shared circuit breaker state, shared cache, and single-deploy mapping updates make the dedicated service economically dominant.

→ See [COST-ANALYSIS.md](COST-ANALYSIS.md) for the full infrastructure cost comparison across three deployment options, break-even analysis, and the five most costly anti-patterns (including why calling the vendor API twice for validation doubles costs and halves rate limit headroom).

---

## AI Integration

The ACL is the correct architectural pattern for absorbing AI vendor volatility — the same problem, in a new domain. LLM vendor response schemas are not stable: OpenAI has changed completion response shapes between API versions, Anthropic has iterated on the Messages API format, and providers add structured output fields without deprecation notices.

**Key ways this pattern extends for AI workloads:**
- **ACL as AI output adapter:** Define a `CanonicalAIResponse` type that represents what your domain needs from any model. Write one translation function per vendor per model version. When the provider changes their API shape, only the translation function changes — not the domain.
- **Schema versioning for AI model outputs:** The ACL's versioned mapping strategy (handling `VendorCustomerV2 | VendorCustomerV3` transitions) applies directly to model version transitions (claude-3 → claude-3.5 → claude-4). Record real API responses as contract test fixtures per model version before writing new translation code.
- **ACL as prompt injection defense boundary:** AI-generated content is untrusted external input. The ACL is the correct place to validate it before the domain trusts it — for the same reason it validates CRM vendor payloads. Once the content enters the domain as a canonical type, domain code trusts it.
- **Domain invariant validation:** Evaluate AI outputs against domain invariants at the ACL boundary (length limits, prohibited terms, required elements) before any canonical type is accepted. The model does not know your domain's rules; the ACL is where you apply them.

→ See [AI-INTEGRATION.md](AI-INTEGRATION.md) for the full LLM output adapter pattern with TypeScript examples, versioned mapping for model transitions, prompt injection defense implementation, and mapping of existing ACL ADRs to AI workloads.

---

## Platform Engineering

The ACL platform provides teams with vendor translation, schema validation, resilience, and credential injection as a service. Teams write the mapping function; the platform handles everything else. When this works, onboarding a new vendor integration takes a day, not a week.

**The paved road model:** A domain team consuming a new vendor should receive HTTP client with retry and circuit breaker, credential injection from Secrets Manager, schema validation on every response, and structured observability — automatically, without building any of these themselves. The self-service scaffold generates the boilerplate; the team writes the translation logic.

**Platform contract:** The platform team commits to 99.9% ACL runtime availability, automatic credential rotation handling, and 30-day notice for any breaking change to the adapter configuration schema. Domain teams commit to translation function correctness, contract test fixture maintenance, and correct PII field classification.

**The bypass signal:** If domain teams call vendor APIs directly, the platform has failed. Make bypass detectable via network policy and vendor audit log comparison. Make using the platform faster than the bypass — that is the correct fix, not enforcement.

→ See [PLATFORM-ENGINEERING.md](PLATFORM-ENGINEERING.md) for the self-service adapter registration schema, platform contract definition, developer experience requirements, canonical model governance process, and signals that the ACL platform has become a bottleneck.

---

## Business Case

One ACL implementation absorbs all future vendor API changes at a single point, prevents multi-service coordinated deployments for vendor-side schema changes, and provides the single PII entry point required for GDPR data minimization compliance.

→ See [EXECUTIVE-BRIEF.md](EXECUTIVE-BRIEF.md) for a one-page business case written for non-technical stakeholders (CPO, CFO, VP Engineering): the problem in plain language, incident cost comparison, what implementation costs in engineer-weeks and monthly infrastructure, what the business gains, and the risk of inaction.

---

## Diagrams

**C4 Model**
- [c4-context.mmd](diagrams/c4-context.mmd) — Level 1: System context (domain services, ACL, vendor systems, secrets manager, observability platform)
- [c4-container.mmd](diagrams/c4-container.mmd) — Level 2: Container breakdown (ACL runtime, schema validator, translation engine, circuit breaker, response cache, credential manager)

**Architecture & Flow**
- [01-context.mmd](diagrams/01-context.mmd) — System architecture context
- [02-translation-sequence.mmd](diagrams/02-translation-sequence.mmd) — Translation sequence from vendor response to canonical domain model
- [03-versioned-mapping.mmd](diagrams/03-versioned-mapping.mmd) — Versioned mapping strategy for vendor API transitions

---

## Architecture Decision Records
- [ADR-001: Adopt Anti-Corruption Layer](adrs/ADR-001-adopt-acl.md)
- [ADR-002: Define canonical domain model](adrs/ADR-002-canonical-model.md)
- [ADR-003: Resilience and timeouts strategy](adrs/ADR-003-resilience-and-timeouts.md)
- [ADR-004: Contract testing against vendor schemas](adrs/ADR-004-contract-testing.md)
- [ADR-005: Versioning and migration strategy](adrs/ADR-005-versioning-and-migration.md)

---

## Example
See `examples/node-acl/` for a minimal runnable demo:
- `core-domain-service` calls the ACL for customer profile data
- `acl-adapter` calls a vendor API and translates vendor payload → canonical customer model
- `vendor-system-mock` simulates a vendor with “weird” field names/types/enums
