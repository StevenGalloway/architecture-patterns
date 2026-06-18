# Team Topology — Anti-Corruption Layer Pattern

## Who Owns the ACL?

Ownership of the Anti-Corruption Layer is not obvious and the wrong answer causes the pattern to fail silently. There are three plausible ownership models, each with different failure modes:

| Ownership Model | When it works | When it fails |
|---|---|---|
| **Consuming team owns their own ACL** | Single vendor, single consumer, low traffic | Six teams, six vendors → six inconsistent canonical models, six credential management approaches, duplicated translation bugs |
| **Dedicated integration team owns all ACLs** | Multiple vendors, enterprise integration org | Becomes a bottleneck; consuming teams wait weeks for new mappings; team owns code it doesn't understand domain-wise |
| **Platform team owns ACL infrastructure; consuming teams own mapping logic** | Multiple vendors, multiple consumers, mature platform | Requires clear contract between platform (resilience, credential management, observability) and consuming team (correctness of translation logic) |

The recommended model for organizations with three or more vendor integrations is the **platform + domain split**: the platform team provides the ACL runtime (HTTP client, circuit breaker, schema validation, credential injection, observability), and the domain-owning team is responsible for the correctness of the canonical model mappings for their domain.

---

## Team Type Classification

| Team | Type | Responsibility |
|---|---|---|
| **Platform Engineering** | Platform team | ACL service runtime, deployment infrastructure, circuit breaker configuration, credential management, observability pipeline, and the scaffold template for new adapters |
| **Domain Team (e.g., Customer)** | Stream-aligned | Canonical model definition for their domain, translation logic correctness, contract test fixtures, consuming the `CanonicalCustomer` type in their domain service |
| **Data / Governance** | Enabling team | Canonical model governance, PII classification at the ACL boundary, data quality standards for translated fields |
| **Security** | Enabling team | Vendor credential policy, secret rotation requirements, ACL bypass detection, output allowlisting standards |

---

## Conway's Law Implications

Conway's Law predicts that your ACL design will mirror your communication structure. The most dangerous outcome:

**Six vendor integrations, six teams → six ACLs with six different canonical models.**

This looks like integration success — each team "solved" their vendor problem. In practice:

- `CustomerId` in the Customer domain ACL is `accountId` in the Billing domain ACL, and `clientRef` in the Support domain ACL. All three refer to the same external entity.
- When the vendor changes their `customer_type` field, each team discovers the break independently. The incident that should take 30 minutes takes 3 days.
- No team has sufficient context to govern the canonical model holistically. Over time, the domain model becomes an inconsistent reflection of whatever each team extracted from the vendor.

**The architectural cure is organizational**: a shared canonical model owned by one team (platform or a designated integration team) with contribution rights — not ownership fragmentation — granted to consuming teams.

The signal that Conway's Law is working against you: open a PR in each team's ACL and compare how each maps `vendor.contact_info`. If you see five different representations, the org structure is dictating the architecture.

---

## Failure Mode: Org Contradicts Architecture

The most common production failure pattern: the ACL exists, but teams have learned to bypass it.

Why this happens:
1. The ACL team is understaffed and vendor integration requests take two weeks.
2. A stream-aligned team has a deadline. They call the vendor API directly from their service.
3. The bypass works. Nobody notices. The pattern repeats.
4. Vendor CRM releases v3. The ACL is updated. The three services that bypassed the ACL break — but they don't appear in any ACL monitoring because they never went through it.

This is not a technical failure. It is an organizational failure that manifests technically. The fix is:
- Make the ACL faster to use than bypassing it (platform scaffold, self-service adapter generation)
- Make bypassing detectable (network policy that blocks direct vendor calls from domain services; alert on vendor API calls that don't originate from the ACL service account)
- Make the value visible (when vendor CRM v3 landed and required changes, how many services were affected? One — the ACL. Show this number to stakeholders.)

---

## Interaction Modes Table

| Interaction | Mode | Description |
|---|---|---|
| Platform team → domain teams | **X-as-a-service** | Domain teams consume the ACL runtime, credential injection, and circuit breaker as platform capabilities. They do not configure these; they consume them. |
| Domain team → platform team | **Collaboration** | Required when onboarding a new vendor integration. Time-boxed (target: 1 week to first working adapter). After that, domain team owns mapping changes independently. |
| Data/Governance → domain teams | **Enabling** | Governance team reviews and approves canonical model fields for PII classification before the model is used in production. They do not own the model; they gate on compliance. |
| Security → platform team | **Enabling** | Security team defines vendor credential lifecycle requirements; platform team implements. Annual review of access patterns via vendor audit logs. |
| Consuming domain services → ACL team | **X-as-a-service** | Services in the customer domain call the ACL's internal API to get `CanonicalCustomer` objects. They do not know which vendor the data came from or what the raw response looked like. |

---

## Scaling the Team Model

### Stage 1: One or two vendor integrations (1–2 teams)

One team owns everything: the vendor HTTP client, the mapping logic, the canonical model, the tests. This is fine. The pattern is still valuable — it localizes translation — but the team topology overhead is not yet justified.

Watch for the first time a second team asks "can I use that customer data too?" That question signals you need Stage 2.

### Stage 2: Three to five vendor integrations (3–6 teams)

This is where the canonical model governance problem becomes real. Establish:
- A shared canonical model definition (TypeScript types in a shared package, or a schema registry)
- A contributing team for each domain (Customer, Product, Order) with a named model owner
- Platform team takes ownership of the ACL runtime infrastructure (the service, its deployment, its circuit breakers, its credentials)
- Domain teams own the adapter logic (the translation functions that produce `CanonicalCustomer` from `VendorCustomerV2 | VendorCustomerV3`)

### Stage 3: Five or more vendor integrations (6+ teams)

At this scale, self-service matters:

| Capability | Target |
|---|---|
| New vendor adapter scaffold | Generated from template in < 1 day |
| Contract test fixture wiring | Pre-wired in scaffold; team adds vendor payloads, not boilerplate |
| Credential provisioning | Automated via secrets manager integration; no manual platform team step |
| Observability | Automatic; zero configuration from domain team |
| New mapping change | Domain team PR with canonical model governance review; no platform team deployment needed |

The platform team at Stage 3 is providing a **capability**, not managing individual adapters. If the platform team is still reviewing translation logic PRs for individual vendors, they have not scaled the model correctly.

---

## Cognitive Load Considerations

The ACL team carries a specific cognitive load that is easy to underestimate: they must maintain a mental model of the vendor's domain as well as the internal canonical domain — and translate between them. This dual-context requirement is cognitively expensive.

Mitigations:
- Translation functions are pure functions with no side effects. A developer can read a mapping function in isolation without understanding the full ACL service.
- Contract tests serve as executable documentation. Reading `translateCustomerV3.test.ts` tells a new team member what the vendor's v3 model looks like and what the expected canonical output is. No wiki required.
- Naming conventions in the adapter layer preserve the vendor's original field names as comments alongside the canonical name. When the vendor documentation says `account_classification`, the code says `canonicalCustomer.accountType = vendor.account_classification; // was customer_type in v2`.
- On-call for the ACL should be shared with consuming domain teams, not owned exclusively by the platform team. A translation bug in the Customer domain ACL is the Customer team's production incident, not the platform team's.
