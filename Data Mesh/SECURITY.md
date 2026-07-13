# Security Architecture — Data Mesh Pattern

## Threat Model

Data Mesh distributes data ownership across domain teams, which distributes the attack surface. In a centralized data architecture, a security review of the data layer is a review of one team's pipelines, one warehouse schema, and one set of access controls. In Data Mesh, it is a review of every domain team's data product — and the platform must enforce security controls that domain teams cannot opt out of, because the alternative is inconsistent data protection at scale.

The governance CI gate is the primary security enforcement mechanism. A data product that fails the security gate cannot be deployed. This is not optional for domain teams — it is the contract under which they receive platform autonomy.

```
Domain Team Repo
      │
      │ git push
      ▼
CI/CD Pipeline
      ├─► PII detection scan (blocks if untagged PII found)
      ├─► Access classification check (blocks if classification missing)
      ├─► Schema contract validation (blocks if contract format invalid)
      ├─► Credential scan (blocks if secrets in code)
      └─► Policy-as-code gate (blocks if governance rules not met)
            │
            ▼ (all gates pass)
      Data Product deployed to platform
      Access control provisioned automatically
      Catalog entry created
      Lineage registration fired
```

---

## Attack Surface

| Attack Surface | Threat | Severity |
|---|---|---|
| PII propagation without tagging | Domain team publishes data product with untagged PII fields; downstream consumers build pipelines without knowing they contain PII; GDPR erasure requests cannot be fulfilled because the data subject's records are not traceable | Critical |
| Cross-domain direct table access | Consumer team bypasses the data product contract and queries the producer domain's source or staging tables directly in the warehouse; gains access to data they were not authorized to see | Critical |
| World-readable data product | Data product published with access classification of "public" or misconfigured ACL that grants all warehouse users read access to restricted data | High |
| Lineage gaps | Transformation code modifies or filters PII but the lineage event is not captured; GDPR right-to-erasure becomes impossible because the lineage graph does not show which downstream products contain the affected data subject | High |
| Breaking schema change without versioning | Producer pushes a breaking schema change without a version bump; consumer pipeline receives unexpected schema silently (column renamed, type changed, column removed); produces wrong data with no error | High |
| Rogue data product | Domain team publishes a data product that joins their domain data with another domain's sensitive data without authorization from that domain's data product owner | High |
| Credential leakage in pipeline code | AWS credentials, database connection strings, or API keys embedded in dbt models or pipeline configuration, committed to the domain team's git repository | High |
| Data exfiltration via consumer contract | Consumer team declares a contract to gain access to a sensitive data product, then exports the data to an unsecured destination (personal S3 bucket, third-party SaaS tool) outside the platform's access control boundary | Medium |
| Catalog poisoning | Attacker or misconfigured automation overwrites catalog metadata to misdescribe a data product's content or access classification, causing consumers to trust data they should not | Medium |
| Stale access | Consumer team loses business need for a data product but their access is never revoked; ex-employee access to data products not terminated on offboarding | Medium |

---

## Security Controls

### PII Classification (Mandatory, Enforced at CI Gate)

PII tagging is mandatory at the data product schema level. Every field in every data product must carry a classification tag. The CI gate blocks deployment if any field is unclassified.

Classification levels:
- `pii_direct` — directly identifies an individual (name, email, phone, SSN, account number)
- `pii_indirect` — could identify an individual in combination with other fields (IP address, device ID, postal code + date of birth)
- `sensitive_non_pii` — confidential business data that is not personal (revenue figures, pricing, trade secrets)
- `internal` — non-sensitive internal data (product SKUs, category names, aggregate counts)
- `public` — appropriate for external sharing

Fields classified as `pii_direct` or `pii_indirect` require:
1. Explicit justification for inclusion in the data product
2. Data product consumer access requests to state a business purpose
3. Masking or tokenization option available for consumers who only need derived signals

### Access Control (Platform-Managed, Not Team-Managed)

Access control is applied per data product via the platform's access control layer, not per-table or per-schema in the warehouse. Domain teams do not manage warehouse grants directly.

When a data product is published:
1. Platform creates a warehouse role scoped to that data product's objects
2. The data product manifest's `classification` field determines the default access policy
3. Consumers request access via the self-service portal; approval routes to the data product owner
4. Platform provisions the warehouse role grant within 5 minutes of approval
5. Access is reviewed quarterly via the platform's access review workflow

This means a malicious or mistaken warehouse GRANT by a domain engineer cannot bypass the access control layer — domain engineers do not have GRANT privileges in the warehouse.

### Data Product Contract Security Requirements

Every data product contract (`contract.yaml`) must include:
- `classification` (one of: restricted, internal, public)
- `pii_fields` (explicit list, empty array if none)
- `consumers` (declared consumer list; unlisted consumers cannot request access without data product owner approval)
- `retention_days` (data retention limit; data older than this threshold must be deleted or archived)

### Lineage as a Security Control

Lineage is not just a debugging tool — it is a GDPR compliance requirement. The platform captures lineage for every platform-managed transformation. A data product that does not emit lineage events on refresh is flagged by the CI gate.

GDPR Art. 17 (right to erasure) requires:
1. Identifying all data products containing records about the data subject
2. Tracing downstream data products that were derived from those records
3. Issuing deletion or masking operations to all affected products

Without automated lineage, this process requires manual cross-team coordination and is operationally unreliable. The lineage graph makes it a queryable operation: `lineage.find_downstream_products(source="customers.customers_curated", field="customer_id", value=X)`.

---

## Compliance Framework

| Standard | Requirement | Data Mesh Control |
|---|---|---|
| **GDPR Art. 17** (right to erasure) | Ability to delete or mask all records about a data subject across all processing systems | Lineage graph traces which data products contain customer records; deletion propagates via lineage to all downstream products |
| **GDPR Art. 30** (processing records) | Maintain a record of all processing activities | Every data product is a processing activity; catalog entry = processing record; auto-generated from manifest |
| **GDPR Art. 25** (privacy by design) | PII minimization in data products | PII field classification is mandatory; non-PII consumer access requires masking of PII fields; CI gate enforces this before deploy |
| **SOC 2 CC6.3** (access authorization) | Logical access based on role authorization, reviewed regularly | Platform access control layer; quarterly access review; consumer access tied to declared business purpose |
| **SOC 2 CC6.6** (network access) | Network controls limiting access to data | Warehouse access is only via platform-managed roles; direct table access from outside the platform is blocked |
| **PCI DSS Req. 3** | Cardholder data must not be stored unnecessarily | Payment card data classified as `restricted` with mandatory encryption; no data product containing raw card data can deploy without explicit security review; `pii_direct` classification triggers mandatory review |
| **PCI DSS Req. 7** | Access to cardholder data on need-to-know basis | Restricted data products require named consumer approval; no group access grants; access logged to audit trail |

---

## Security Review Checklist

Before any data product reaches production:

- [ ] All schema fields carry a PII classification tag (CI gate enforces; verify no suppressions)
- [ ] `pii_direct` or `pii_indirect` fields have a documented justification in the contract
- [ ] Access classification (`restricted`, `internal`, or `public`) is set and matches the actual sensitivity of the data
- [ ] No credentials, connection strings, or API keys appear in pipeline code or configuration (credential scanner in CI; verify no suppressions)
- [ ] Lineage events are emitted on every refresh (verify in lineage service logs after first deployment)
- [ ] Consumer list in the contract reflects actual intended consumers, not a blanket open access grant
- [ ] Data retention policy is set in the contract and matches the domain's data classification policy
- [ ] Breaking schema changes increment the contract version (not silently deployed to existing consumers)
- [ ] Data product does not join across domain boundaries to include another domain's restricted fields without that domain's data product owner approval
- [ ] GDPR erasure procedure is documented for any data product containing customer PII (what happens to this product when a deletion request is issued?)
