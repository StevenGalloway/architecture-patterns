# Platform Engineering — Anti-Corruption Layer Pattern

## The ACL as a Platform Capability

A mature platform engineering team does not hand each stream-aligned team a blank page and tell them to integrate the CRM. They provide:

1. A **runtime** (the ACL service, pre-wired with circuit breakers, credential injection, observability, and caching)
2. A **scaffold** (a code template for a new vendor adapter that generates the boilerplate and wires into the runtime automatically)
3. A **canonical model registry** (the source of truth for stable internal types, versioned and governed)
4. A **contract test harness** (pre-wired fixtures and test runner; teams add vendor payloads, not test infrastructure)

When these four capabilities exist, adding a new vendor integration should take a domain team one week, not one month. Without them, every team rebuilds the same boilerplate, makes the same mistakes, and creates inconsistent canonical models that diverge across the organization.

---

## The Paved Road for Vendor Integrations

| Without ACL platform capability (dirt road) | With ACL platform capability (paved road) |
|---|---|
| Each team writes their own HTTP client for the vendor API | Vendor HTTP client with retry, timeout, and circuit breaker is provided by the platform runtime |
| Each team manages their own vendor API credentials | Platform injects credentials from Secrets Manager at deploy time; teams never handle raw secrets |
| Each team defines their own "customer" type for the same vendor | Canonical model is defined once; teams consume the shared type and contribute to it via governance process |
| Each team discovers vendor schema changes when production breaks | Contract tests run in CI against vendor sandbox; schema drift is caught before deployment |
| Each team writes their own structured logging for vendor calls | Observability is automatic: every vendor call produces a structured log entry with vendor name, endpoint, latency, and translation result |
| New vendor onboarding takes 3–6 weeks | Scaffold generates 80% of the boilerplate in a day; team writes translation logic for their domain |

The paved road does not restrict what domain teams can do — it makes the right thing faster than the wrong thing.

---

## Self-Service: Requesting a New Vendor Integration

The self-service process for onboarding a new vendor integration should require no platform team ticket, no meeting, and no gate beyond an automated PR check.

### Step 1: Generate the adapter scaffold

```bash
# Platform-provided CLI tool
npx @platform/acl-scaffold new-adapter \
  --vendor salesforce-crm \
  --version v3 \
  --domain customer \
  --canonical-types CanonicalCustomer,CanonicalContact
```

This generates:
```
acl-adapters/
  salesforce-crm-v3/
    adapter.ts          # Empty translation function stubs to implement
    schema.json         # JSON Schema to fill in with vendor field definitions
    adapter.test.ts     # Contract test harness (pre-wired); add fixture files
    fixtures/           # Add vendor sandbox response payloads here
    README.md           # Instructions for the domain team
```

### Step 2: Implement the translation functions

The domain team fills in the translation logic in `adapter.ts`. The canonical types (`CanonicalCustomer`, `CanonicalContact`) are imported from the shared canonical model package — the domain team does not define them.

```typescript
import { CanonicalCustomer } from '@platform/canonical-models';
import { SalesforceCRMV3Customer } from './schema';

export function toCanonicalCustomer(
  vendor: SalesforceCRMV3Customer
): CanonicalCustomer {
  return {
    accountId:    vendor.Id,
    fullName:     `${vendor.FirstName ?? ''} ${vendor.LastName}`.trim(),
    contactEmail: vendor.Email,
    accountType:  toCanonicalAccountType(vendor.Type),
    isActive:     vendor.IsActive && !vendor.IsDeleted,
  };
}
```

### Step 3: Add contract test fixtures

The domain team records real vendor sandbox responses and saves them as JSON files in `fixtures/`. The test harness picks them up automatically and asserts that the translation function produces the expected canonical output.

### Step 4: PR with automated checks

The PR runs:
- TypeScript typecheck (canonical types must be satisfied)
- Contract tests against fixtures
- Schema validation (the JSON schema must be complete)
- Allowlist check (no fields mapped that are not in the canonical type — prevents over-mapping)

No platform team approval is needed for the translation logic. The automated checks enforce correctness. Platform team reviews are required only for changes to the canonical model itself.

---

## Platform Contract

The platform team publishes and maintains a formal contract for the ACL capability. Stream-aligned teams can rely on this contract when planning their integration work.

### What the platform provides

| Capability | Guarantee |
|---|---|
| ACL service availability | 99.9% monthly uptime for the ACL runtime infrastructure |
| Canonical model stability | Published canonical types are stable within a major version. Breaking changes require minimum 60 days advance notice and a migration path. |
| Credential management | Vendor credentials are rotated automatically; domain teams do not need to manage rotation or access secrets directly |
| Vendor call observability | Every vendor call is logged with latency, status, and translation result automatically — no domain team instrumentation required |
| Circuit breaker protection | Vendor outages trigger circuit breakers automatically; domain teams receive a `503` from the ACL rather than hanging connections or cascading failures |
| Schema validation | Vendor payloads are validated against the expected schema before translation; malformed payloads are rejected and logged before they reach domain code |
| Contract test runner | The CI pipeline runs contract tests against vendor sandboxes on every PR; no additional CI configuration required from domain teams |

### What domain teams are responsible for

| Responsibility | Owner |
|---|---|
| Translation function correctness | Domain team (the team that owns the consuming service) |
| Contract test fixtures | Domain team (must record real vendor sandbox responses, not synthetic data) |
| Vendor sandbox account maintenance | Domain team (or jointly with vendor relationship owner) |
| Canonical model contribution proposals | Domain team (submit a PR to the canonical model package; platform/governance team reviews) |
| Consumer SLO compliance | Domain team (the ACL provides availability; consumers must handle ACL-returned errors correctly) |

---

## Canonical Model Governance

The canonical model is the most critical shared artifact the platform provides. It is the internal language that all vendor translations produce and all domain services consume. Instability or inconsistency in the canonical model defeats the purpose of the ACL.

**Governance process:**

1. **Model ownership:** Each entity type in the canonical model has a named owner team. `CanonicalCustomer` is owned by the Customer domain team. `CanonicalOrder` is owned by the Order domain team. The owning team is responsible for the semantic correctness of the type.

2. **Change process for non-breaking additions:** Adding a new optional field to a canonical type is a non-breaking change. PR to the canonical model package; owning team approves; platform team merges and releases a minor version. All consuming services receive the new field without requiring updates.

3. **Change process for breaking changes:** Renaming a field, changing a type, or removing a field is a breaking change. The process requires: a 60-day notice in the platform changelog, a migration guide for consuming services, a version bump (v1 → v2 of the type), and a transition period where both versions are available.

4. **No accretion rule:** If a canonical type grows to more than 25 fields, it is a signal that the canonical model is becoming a dumping ground. Review which fields are actually used by consumers before adding new ones. Unused fields carry maintenance cost with no benefit.

---

## Signals the ACL Has Become a Platform Anti-Pattern

Watch for these signals that the ACL platform capability has degraded:

| Signal | What it indicates | What to do |
|---|---|---|
| Domain teams bypass the ACL and call vendor APIs directly | ACL onboarding is too slow, or the canonical model doesn't cover their use case | Reduce onboarding time; extend canonical model; make bypass detectable and visible |
| Canonical model has grown to 50+ fields, most with no active consumers | The model was extended speculatively or to "hedge" against future needs | Audit active consumers; deprecate unused fields; enforce no-accretion on new additions |
| New vendor onboarding takes more than 2 weeks | Scaffold is insufficient; too much manual platform team involvement | Improve the scaffold; reduce required platform team approvals; automate credential provisioning |
| Contract tests are disabled or skipped because vendor sandbox is unreliable | Platform team has accepted reliability debt in contract testing | Fix the vendor sandbox relationship; invest in synthetic contract testing if vendor sandbox is structurally unreliable |
| Translation logic contains domain business rules (pricing calculations, eligibility logic) | ACL scope has grown beyond translation | Extract business logic to the domain service; keep ACL limited to translation + validation + resilience |
| Multiple teams have created their own canonical types for the same entity | Canonical model governance has broken down | Consolidate; identify the authoritative type; deprecate duplicates; require governance process for future additions |

---

## Golden Path Integration Points

The ACL platform capability connects to other platform primitives:

```
Secrets Manager ─────────────────► ACL Runtime (vendor credential injection)
                                          │
Service Scaffold ─────────────────► New Adapter Template
                                          │
Canonical Model Registry ─────────► Shared Type Package (all consumers import from here)
                                          │
Contract Test Runner ──────────────► CI Pipeline (per adapter, automatic)
                                          │
Observability Platform ◄──────────── ACL Structured Logs + Metrics
                                          │
Circuit Breaker State Store ───────► Shared Redis (vendor health, visible to all adapters)
```

From a domain team's perspective: they write translation logic and fixture files. Everything else is provided. This is what "paved road" means in practice — not a metaphor, but a measurable reduction in the scope of work a domain team must do to integrate a new vendor.
