# Security Architecture — Anti-Corruption Layer Pattern

## Threat Model

The ACL is a trust boundary between two different trust domains: the external vendor (untrusted) and the internal core domain (trusted). Its security properties are not the same as a public-facing API gateway. The threats are different, the controls are different, and the failure modes are different.

The core risk: **the ACL's job is to translate between domains. A security failure in translation can carry a threat from the untrusted domain directly into the trusted domain — dressed in the domain's own language.**

```
Vendor System (untrusted) → ACL (translation boundary) → Core Domain (trusted)
                                        ↑
                         Security failures here corrupt the trust boundary
                         in both directions: inbound (vendor → domain)
                         and outbound (credential exposure, data leakage)
```

---

## Attack Surface Table

| Attack Surface | Threat | Severity | Notes |
|---|---|---|---|
| **Vendor payload injection** | Malicious content in a vendor response field passes through ACL into core domain without sanitization — script content, SQL fragments, or oversized payloads | High | Vendor is untrusted. The ACL must treat all vendor-supplied content as untrusted input, even if the vendor is a reputable SaaS. Compromised vendor accounts or vendor-side vulnerabilities can inject malicious payloads. |
| **ACL bypass** | A domain service calls the vendor API directly, bypassing the ACL. The result: unvalidated vendor data enters the domain, no canonical translation occurs, PII enters services not designed to handle it. | Critical | This is not just a logic bug — it is a security control failure. The ACL is the designated boundary for PII handling, schema validation, and credential scoping. Bypass means all of those controls are absent. |
| **Data leakage via over-mapping** | ACL maps more vendor fields into the canonical model than any consumer needs. PII fields (`ssn`, `date_of_birth`, `bank_account_number`) are translated and forwarded to services that have no business reason to receive them. | High | The ACL is the natural chokepoint to strip PII before it enters the domain. Mapping fields "just in case" defeats GDPR data minimization requirements and expands the PII attack surface. |
| **Vendor credential exposure** | API keys, OAuth client secrets, or mTLS certificates for vendor API access are stored in application configuration, environment variables, or source code rather than a secrets manager. | Critical | Vendor credentials allow an attacker to impersonate your system to the vendor — placing fraudulent orders, exfiltrating customer data, or exhausting vendor rate limits causing denial of service to your system. |
| **Schema drift exploitation** | An attacker (or compromised vendor account) causes a vendor schema change that the ACL's schema validator does not detect, allowing a malformed payload to pass through. If the translation function assumes a field type that changed, the result may silently corrupt domain data. | High | Example: vendor field `account_status` changes from a string enum (`"active"`, `"blocked"`) to a numeric code (`1`, `0`). ACL maps the string; receives a number; translation silently produces `null`; domain logic treats `null` status as "not blocked" by default. |
| **Translation logic that changes security semantics** | A bug in translation logic maps a vendor "blocked" or "suspended" account status to the canonical `"active"` status. The domain trusts the canonical type; it never re-checks the vendor value. A blocked account can now operate freely. | Critical | This is the most dangerous ACL-specific vulnerability. The domain's trust in the canonical model means translation errors on security-relevant fields have immediate downstream consequences. |
| **Replay of stale cached responses** | The ACL caches vendor responses. If an account is blocked in the vendor system, the block may not be reflected in the ACL cache until the TTL expires. During this window, the blocked account is served stale "active" data. | Medium | Cache TTL must be calibrated against the sensitivity of the cached data. Account status data should have a short TTL (seconds to minutes) or be excluded from caching entirely. |
| **Credential stuffing via vendor rate limit reset** | By triggering vendor rate limit errors (forcing the ACL to back off), an attacker who can influence ACL request patterns can cause periods of stale or unavailable data that they then exploit. | Low | Primarily relevant for high-security contexts. Circuit breaker open state should return cached data, not an error that signals to callers that the vendor is unavailable. |

---

## Vendor Credential Management

Vendor API keys are the most sensitive secrets the ACL manages. They represent access to an external system that holds your customer data.

| Secret Type | Storage Requirement | Rotation Policy |
|---|---|---|
| Vendor API key (static) | AWS Secrets Manager or HashiCorp Vault. Never in `.env` files, Kubernetes ConfigMaps, or source code. | Rotate on: new key issuance, personnel offboarding from ACL team, any suspected exposure |
| Vendor OAuth client secret | Secrets Manager. ACL fetches token at startup and refreshes on expiry. Client secret never logged. | As per vendor's policy; minimum annual rotation |
| Vendor mTLS client certificate | Vault PKI or ACM Private CA. Short-lived certificates preferred (30-day TTL). | Automated; alert if renewal fails > 48 hours before expiry |
| Vendor webhook signing secret | Secrets Manager. Used to verify inbound webhooks from vendor. | Rotate annually; verify vendor supports grace period for dual-key validation during rotation |

**Audit requirement:** Every access to a vendor credential must produce an audit log entry (AWS CloudTrail for Secrets Manager access). This log is the evidence for SOC 2 CC6.1 and vendor access reviews.

---

## Input Validation at the Boundary

The schema validator component sits between the raw vendor response and the translation engine. It must reject any payload that does not conform to the expected schema **before** translation begins.

```
Vendor Response (raw JSON)
         │
         ▼
Schema Validator
  ├─ Expected fields present?
  ├─ Field types correct? (string where string expected, not number or null)
  ├─ Enum values within known set?
  ├─ No unexpected additional fields that could carry injection content?
  └─ Payload size within bounds?
         │
   PASS  │  FAIL → log, alert, return error to consumer (do not return raw vendor error)
         ▼
Translation Engine
```

Validation failures must never be silently swallowed. A vendor schema change that the ACL was not prepared for should trigger an alert — it is a canary for unexpected vendor behavior that may require immediate human review.

**Strict vs. lenient schema validation:**

For security-relevant fields (account status, role, entitlement flags), use strict validation: reject payloads where these fields are missing or wrong-typed. For informational fields (display names, addresses), lenient handling is acceptable (use a default or null for missing fields). The configuration of which fields are strict must be documented and reviewed by the security team.

---

## Output Allowlisting

The ACL must map **only the fields that consumers have a documented need for**. This is enforced as an output allowlist, not a field exclusion list.

A field exclusion list ("map everything except `ssn`") is fragile: when the vendor adds a new sensitive field, the exclusion list must be updated proactively. An allowlist ("map only these fields: `accountId`, `fullName`, `contactEmail`, `accountType`, `isActive`") is safe by default: new vendor fields that are not on the allowlist are silently dropped.

```typescript
// Allowlist pattern — safe by default
function toCanonicalCustomer(vendor: VendorCustomerV3): CanonicalCustomer {
  return {
    accountId:    vendor.id,
    fullName:     vendor.display_name,
    contactEmail: vendor.email_address,
    accountType:  toCanonicalAccountType(vendor.account_classification),
    isActive:     vendor.status === 'active',
    // vendor.ssn, vendor.date_of_birth, vendor.bank_account are not mapped
    // even if they appear in the vendor payload
  };
}
```

Do not use spread operators (`{ ...vendor, accountId: vendor.id }`) — they carry all vendor fields into the output, defeating the allowlist.

---

## PII Handling at the ACL Boundary

The ACL is the designated point where vendor PII enters the internal domain. This makes it the natural control point for GDPR data minimization, PCI scoping, and SOC 2 data handling requirements.

**Controls at the ACL boundary:**

1. **Strip before transit:** PII fields that consuming services do not need are dropped at translation time, before the canonical model leaves the ACL. This is not a logging concern — it is a structural one.

2. **Mask in logs:** The ACL's structured log must not emit PII in plaintext. `contactEmail` must be hashed or partially masked. Full addresses, phone numbers, and national IDs must never appear in access logs.

3. **PII field register:** Maintain an explicit register of which canonical model fields contain PII. This register feeds into:
   - The data privacy impact assessment (DPIA) for GDPR Article 35
   - The data processing records (Article 30)
   - The PCI scope assessment (is the ACL in-scope for cardholder data handling?)

4. **Differential access by consumer:** If one consuming service needs `contactEmail` but another does not, consider separate canonical model projections rather than a single canonical type with all fields. This is the field-level equivalent of the ACL's domain separation principle.

---

## ACL Bypass Detection

Because the ACL bypass threat is both high-severity and difficult to detect from within the ACL (a bypassing service doesn't call it at all), detection must come from the network layer and the vendor access log.

| Detection mechanism | How it works |
|---|---|
| **Network policy** | Domain services run in a network segment that is not permitted to reach vendor API endpoints. Only the ACL service account's egress is permitted to vendor IP ranges. Any direct vendor call from a domain service fails at the network layer. |
| **Vendor access log audit** | Request vendor audit logs monthly. Compare the `client_id` or `api_key` used for each call. Any API key that is not the ACL service's key but belongs to your organization indicates a bypass or a leaked credential. |
| **ACL call volume vs. expected domain call volume** | If the Order service calls the ACL for customer data 10,000 times per day but the Customer service receives 20,000 customer lookups per day from Order, the gap suggests some Order service calls are not going through the ACL. |

---

## Compliance Relevance

| Standard | ACL's specific role |
|---|---|
| **GDPR Article 5 (Data Minimization)** | The ACL is where minimization is enforced structurally: only map fields consumers need. This is a technical implementation of the minimization principle, not just a policy. |
| **GDPR Article 28 (Data Processor)** | If the vendor is a data processor, the ACL is where data from that processor enters your systems. The DPA with the vendor must cover the data the ACL is extracting. The ACL's PII field register is the evidence that you know what data you're receiving. |
| **GDPR Article 30 (Records of Processing)** | The ACL's translation functions, when combined with the PII field register, constitute records of processing: what data, from what source, going to what internal systems. |
| **SOC 2 CC6.1 (Logical Access Controls)** | The ACL's vendor access log (which requests were made, with which credentials, at what time) is the audit evidence for vendor API access control. The credential management approach (Secrets Manager) is the control. |
| **SOC 2 CC7.2 (Monitoring for Unauthorized Access)** | ACL bypass detection (network policy enforcement + vendor audit log review) is the implementation of this control for vendor integrations. |
| **PCI DSS Requirement 1** (Network segmentation) | If the vendor handles cardholder data (e.g., a payment platform), the ACL is the boundary between the CDE-adjacent vendor and your domain. Network policy preventing direct domain service access to the vendor is the segmentation control. |
| **PCI DSS Requirement 3** (Protect cardholder data) | If cardholder data transits the ACL, the PII handling controls (strip before transit, mask in logs) are PCI controls. The ACL's canonical model must not persist cardholder data unless the service has PCI scope justified. |

---

## Security Review Checklist

Before any ACL change that modifies translation logic or adds a new vendor integration:

- [ ] Output allowlist reviewed: only fields with documented consumer need are mapped
- [ ] Security-relevant fields (status, role, entitlements) use strict schema validation — missing or wrong-typed values are rejected, not defaulted
- [ ] No enum fallback that maps an unknown value to an "allow" or "active" state
- [ ] Vendor credentials are sourced from Secrets Manager at runtime; not present in configuration files, environment variable definitions in container specs, or source code
- [ ] PII field register updated with any new fields that are PII-classified
- [ ] ACL access log schema verified: no PII fields emitted in plaintext
- [ ] Network policy verified: domain services cannot reach vendor API endpoints directly
- [ ] Contract test covers the security-relevant vendor fields (not just happy-path field mapping)
- [ ] Cache TTL for account status and entitlement data reviewed — should not be long enough to serve stale authorization data during a real-time status change
