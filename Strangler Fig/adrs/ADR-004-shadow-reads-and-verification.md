# ADR-004: Use shadow reads and output comparison before cutover

## Status
Accepted

## Date
2026-02-04

## Context
Legacy systems accumulate undocumented behavior. The Billing monolith's invoice calculation logic had been modified 47 times over 8 years. Some modifications fixed bugs in previously incorrect calculations that had been in production long enough to be considered "correct" by the business. Other modifications had subtle side effects that were not captured in test cases.

When the new Billing service was built, the team referenced the monolith's source code and wrote behavior specifications from it. But the monolith's code had diverged from its original documentation, had dead code paths that were never triggered in production, and had conditional logic that handled edge cases from specific customer configurations that no longer existed.

There was no reliable way to know whether the new Billing service's output would match the monolith's output for all real production inputs without actually testing it against production inputs. Unit tests covered the specified behavior; they could not cover undocumented behavior that was in production but not in any specification.

Shadow testing -- running the new service in parallel with the monolith, comparing outputs, without the new service affecting actual user outcomes -- was the mechanism to close this gap.

## Decision
Before any canary traffic is routed to the new service, a shadow period runs for a minimum of 2 weeks. During the shadow period:

**Traffic mirroring:** The Edge Router duplicates each request to `/billing/*` -- the original goes to the monolith (authoritative), and a shadow copy goes to the new Billing service (non-authoritative). The shadow copy is a read-only simulation: the new service processes the request and generates a response but does not write to the production database or send any emails/notifications.

**Output comparison:** A comparison service receives both the monolith's response and the new service's response for each request. It computes a diff and emits metrics:
- `shadow.diff_rate`: percentage of requests where outputs differ (any field)
- `shadow.diff_rate.critical_fields`: diff rate for business-critical fields (`invoice_total`, `tax_amount`, `due_date`, `payment_status`)
- `shadow.diff_rate.formatting`: diff rate for non-critical formatting differences (field names, date formats)

**Cutover gate:** Shadow testing must reach a diff rate below 0.1% for critical fields over a 7-consecutive-day period before canary traffic is enabled. Formatting differences (non-critical fields) are allowed up to 2%.

**Golden dataset replay:** In addition to live shadow traffic, a curated set of 500 historical invoices is replayed against the new service daily. These "golden" requests cover edge cases (zero-amount invoices, multi-currency, partial payments, disputed invoices) that may not appear in the shadow window. The golden dataset must produce zero critical field diffs.

## Alternatives Considered

**Manual acceptance testing before cutover:** The QA team manually tests the new Billing service against a staging environment with production-like data. Relies on test coverage of known scenarios. Rejected as the primary validation because manual testing cannot cover the full range of production traffic patterns, especially edge cases that are rare but present in 8 years of production data. Shadow testing automatically exercises every production request shape.

**A/B testing with user opt-in:** A small group of users is selected to use the new Billing service for real billing operations. Any discrepancies they experience are reported and fixed. Rejected because it exposes real users to potential billing errors. Shadow testing validates without user exposure.

**Code review and specification comparison only:** Compare the new service's implementation against the monolith's source code to verify behavioral equivalence. Rejected because the monolith's source code includes dead code paths, undocumented edge cases, and behavior that emerged from bugs that were never fixed, making code comparison insufficient for behavioral verification.

## Consequences

### Positive
- The shadow period covers 100% of production traffic patterns over a 2-week window, including edge cases that are rare but present in production
- The 0.1% critical field diff cutover gate provides a quantitative, non-negotiable criterion for cutover readiness
- The golden dataset replay ensures that specific known edge cases are always verified, even if they do not appear in the shadow window during a specific day

### Negative
- Shadow traffic doubles the compute load on the billing path: every billing request is processed twice. For high-volume billing periods (month-end invoice generation), this doubles the compute cost during the shadow phase.
- The shadow service must be able to simulate write operations (database writes, email sends) without actually performing them; building this simulation layer adds development overhead to the new service implementation

### Risks
- **Shadow comparison missing semantic differences.** Two responses that differ only in field ordering or timestamp precision (both within acceptable tolerance) are flagged as diffs, while a semantically incorrect response that happens to format the same way as the monolith is not flagged. The diff comparison must be semantic (value comparison) not syntactic (byte comparison). Mitigation: the comparison service uses a structured comparison with per-field tolerance rules.

## Review Trigger
Revisit the 2-week shadow period requirement if the diff rate reaches 0% within the first 3 days for multiple consecutive extractions, which may indicate the shadow period can be shortened safely.
