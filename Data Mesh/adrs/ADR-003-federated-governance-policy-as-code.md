# ADR-003: Federated governance with policy-as-code gates

## Status
Accepted

## Date
2025-09-24

## Context
Federated governance is the hardest principle of Data Mesh to operationalize. The challenge is enforcing organizational standards consistently across domain teams that have autonomy over their own pipelines, without creating a central review bottleneck that reintroduces the scaling problem that motivated Data Mesh adoption.

Two approaches were considered during the model design: a governance council that reviews and approves data products before they are published, and automated policy enforcement that rejects non-compliant data products without human involvement in the approval path.

The governance council model was piloted for the first three months. The council met weekly. Domain teams waiting for council review experienced an average 8-day delay from pipeline completion to catalog publication. The council's feedback was often the same recurring issues: missing PII classification, non-standard field naming, freshness SLOs above the platform maximum. These are mechanical checks that do not require human judgment.

A PII breach in the third month demonstrated the cost of manual governance: a dataset containing customer email addresses was published without PII classification because the domain team was unaware of the classification requirement, and the council review had been skipped due to a missed meeting. The dataset was accessible to analysts who did not have the access rights required for PII data for 11 days before the breach was discovered.

## Decision
Governance standards are enforced as automated policy-as-code gates in the CI/CD pipeline. Data products that fail policy checks cannot be deployed to the catalog. Human review is not in the deployment critical path; the policy code replaces human review for mechanical compliance checks.

**Automated gates enforced in CI:**

- **Naming conventions:** Field names must be `snake_case`; dataset names must follow the `{domain}.{product_name}` pattern; reserved keywords are rejected
- **Contract completeness:** All required contract fields must be present and non-empty (validated by the contract schema from ADR-002)
- **PII tagging:** Any field with a name matching PII patterns (`email`, `phone`, `ssn`, `ip_address`, `full_name`, and others in the PII lexicon) must have explicit `pii_classification` set; mismatches between field name and classification trigger a review requirement
- **Test coverage:** Data products must include at least one data quality test (not null check, range check, or referential integrity check) per non-nullable field; test coverage below this threshold fails the gate
- **Freshness SLO within platform range:** Max lag must be between 15 minutes and 30 days; values outside this range indicate a misconfigured SLO or a use case that requires a different platform capability

**Policy council role (after automation):** The governance council transitions to maintaining and updating the policy rules, not reviewing individual data products. New PII categories, naming convention updates, and SLO range changes go through the council as policy changes, not as individual product reviews.

## Alternatives Considered

**Central approval board for all data product deployments:** A human-staffed board reviews each data product before catalog publication. Rejected (after being piloted) because the 8-day average review time reintroduces a bottleneck, and mechanical checks (naming, PII tagging) do not require human judgment.

**Opt-in governance (guidelines without enforcement):** Publish governance standards as documentation and rely on domain teams to comply voluntarily. Rejected after the PII breach incident demonstrated that opt-in compliance produces gaps in areas where consequences are not immediately visible to the team that made the decision.

**Central governance team with veto power (not approval board):** The governance team can retroactively revoke a published data product if it discovers non-compliance, but does not approve in advance. Rejected because retroactive revocation after a dataset has consumers disrupts those consumers and creates trust problems.

## Consequences

### Positive
- Domain teams receive immediate automated feedback on compliance issues during development (CI runs on every PR), not after waiting for a human review cycle
- PII tagging enforcement eliminates the category of breach caused by "team was unaware of the classification requirement"
- The governance council can focus on evolving standards rather than administering reviews

### Negative
- Policy-as-code requires the platform team to maintain and evolve the policy rules; rules that are too strict block legitimate data products; rules that are too lenient allow non-compliant products through
- Some governance concerns require judgment that policy code cannot express (e.g., "does this field's description accurately reflect the data's semantics?"); these remain human review items but are outside the automated deployment gate

### Risks
- **Policy rule bypass.** A team that cannot comply with a policy rule (e.g., has a legitimate reason for a field name that matches a PII pattern but is not actually PII) may find ways to bypass the check rather than engaging with the governance council to update the policy. Mitigation: the policy gates include an exception mechanism (a documented override with required justification) that is auditable and triggers a governance council notification.

## Review Trigger
Revisit the automated policy rules annually or after any significant regulatory change that introduces new data handling requirements. Revisit the enforcement model if the volume of exception requests indicates that the policy rules are too strict for normal domain team operation.
