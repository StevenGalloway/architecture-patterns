# Security: Feature Flags and Remote Configuration

## Threat Model

Feature flag systems control production behavior at runtime without a code deploy. This makes the management plane a high-value target: an attacker who can write to the flag management API can change production behavior for all users instantly. The attack surface is different from a typical API because flag writes have immediate operational impact, not just data exposure.

### Attack Surface Table

| Attack Surface | Threat | Severity |
|---------------|--------|----------|
| Management API write access | Unauthorized actor enables a disabled dangerous feature or disables an active security control (WAF bypass flag, rate limiting kill switch) | Critical |
| SDK API key compromise | Attacker reads all flag state including unreleased features, internal canary rollouts, and tenant entitlement structure — effectively a product roadmap leak | High |
| PII in targeting rules | Email addresses or names in targeting rules are exposed via audit log to all engineers with log access; audit log export to SIEM further broadens exposure | High |
| Kill switch availability | On-call engineer cannot reach management API during an incident → cannot disable a failing feature without a full code deploy (minutes to hours) | High |
| Flag eval as auth bypass | Team gates a feature with a flag instead of adding proper RBAC → disabling the flag exposes the endpoint to all authenticated users; the feature was never actually restricted | High |
| Audit log tampering | Mutable audit log allows a bad actor to modify a flag, observe damage, then remove the audit record before the incident review | Medium |
| Targeting rule complexity | Overlapping rules with undefined precedence create unpredictable variant assignment → security controls evaluated differently than the rule author expected | Medium |
| SDK cache staleness | Stale SDK cache during management API outage serves old flag state → a kill switch flip to disable a compromised feature does not propagate to SDK instances | Medium |

---

## Controls

### Management API RBAC

Three roles with explicit scope:

| Role | Permissions |
|------|-------------|
| **Reader** | View flag definitions, targeting rules, audit log entries |
| **Writer** | Create flags, update targeting rules, update flag values; cannot delete flags or manage access |
| **Admin** | Delete flags, manage team access grants, rotate SDK API keys, export audit log |

**Critical operational requirement:** On-call engineers must have pre-provisioned access to flip kill-switch flags **before incidents occur**. Emergency access requests (break-glass procedures) take 10–30 minutes during an incident — this is too slow. Kill switch operations (changing an Ops flag to disabled state) must be executable by any on-call engineer with Reader-or-Writer access. Do not require Admin access to flip a kill switch.

**Implementation:** Ops-type flags can be granted a `kill-switch-operator` sub-role that allows a single write operation: setting the flag's enabled state to false. This is narrower than full Writer access and can be safely granted to all engineers on the on-call rotation.

---

### SDK API Key Management

- SDK keys are **read-only**: they authorize reading current flag state, not writing flag definitions or targeting rules
- One SDK key per environment (dev, staging, production) — never share keys across environments
- Store SDK keys in secrets manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager) — never in container definition environment variables, Kubernetes ConfigMaps, or application config files checked into version control
- Key rotation schedule: quarterly for production keys, annually for non-production
- On suspected compromise: rotate immediately; SDK instances pick up new key at next secrets manager poll cycle (typically < 60 seconds with agent-based refresh)
- SDK key compromise incident classification: treat as a production data exposure. The leaked key exposes all flag state including unreleased feature names, cohort targeting structure, and tenant entitlement configuration — this is a product roadmap and customer data leak even though no user PII is in the flags themselves.

---

### Audit Log Immutability

The audit log is the definitive record of who changed which flag, when, and what the change was. Its security value is contingent on immutability.

**Implementation options (in order of strength):**
1. **S3 with Object Lock (WORM mode):** Write flag change records to S3 with Object Lock in compliance mode. Records cannot be deleted or modified, even by the bucket owner, for the retention period. Strongest option; no database-level protection needed.
2. **Database insert-only constraint:** PostgreSQL table with a BEFORE UPDATE/DELETE trigger that raises an exception. Insert only. Weaker than S3 Object Lock because a superuser can disable triggers, but sufficient against application-layer tampering.
3. **Audit log replication to SIEM:** Export all audit log records to a SIEM (Splunk, Datadog, Elastic) within 24 hours of creation. Even if the primary audit log is compromised, the SIEM copy provides an independent record.

**Required fields per audit record:**
```json
{
  "eventId": "uuid-v4",
  "timestamp": "ISO 8601 UTC",
  "actorType": "user | system | api-key",
  "actorId": "user ID or system identifier",
  "actorIp": "source IP",
  "action": "flag.create | flag.update | flag.delete | targeting.update | access.grant | key.rotate",
  "flagKey": "the affected flag key",
  "previousValue": { ... },
  "newValue": { ... },
  "changeReason": "free text — optional but encouraged"
}
```

---

### No PII in Targeting Rules

Targeting rules are stored in the flag database, appear in the audit log, are visible to all engineers with Reader access, and are exported to SIEM and audit log systems. PII in targeting rules creates exposure across all of these surfaces.

**Enforcement at the API layer:**

The management API rejects any targeting rule that contains:
- Any field named: `email`, `name`, `firstName`, `lastName`, `phone`, `address`, `ssn`, `dob`
- Any string value matching email pattern: `\S+@\S+\.\S+`
- Any string value matching E.164 phone pattern: `\+?[1-9]\d{7,14}`

**Correct pattern:**
```json
// REJECT: PII in targeting rule
{
  "attribute": "email",
  "operator": "in",
  "values": ["alice@example.com", "bob@example.com"]
}

// ACCEPT: Opaque identifier in targeting rule
{
  "attribute": "userId",
  "operator": "in",
  "values": ["usr_4f8b2c1d", "usr_9a3e7b2f"]
}
```

The mapping from email/name to opaque userId is maintained in the identity service, not in the flag system. Flag targeting rules reference only opaque identifiers.

---

### Flag vs. RBAC: The Critical Anti-Pattern

Feature flags control **visibility** — which users see a feature. RBAC controls **authorization** — which users are permitted to perform an action.

**The failure mode:**
A team adds a feature flag check at the top of an API endpoint handler to hide a new feature during rollout. The flag evaluates to `false` for most users, so the endpoint appears disabled. But the endpoint exists and is accessible to any authenticated user who discovers its path. When the flag is eventually disabled (or if it is compromised), the endpoint is exposed without authorization logic.

**The correct pattern:**
- Feature flags gate UI visibility and product experience
- RBAC gates API endpoint access
- Both exist simultaneously; the flag disables the UI affordance, the RBAC layer enforces the access restriction

**Enforcement:** Code review gate on any PR that adds a feature flag evaluation inside an authorization function, permission check, or middleware. This is documented as a prohibited pattern in engineering guidelines. If a reviewer sees `if (flagClient.evaluate('new-payment-feature', userContext))` inside a payment authorization function, the PR is rejected.

---

## Compliance Mapping

### SOC 2 CC6.1

**Requirement:** Logical access controls restrict access to production systems; access changes are logged.

**Flag system control:** Management API RBAC restricts write access to flag definitions. Every flag change records actor identity, timestamp, IP, and full before/after diff in the immutable audit log. Access grants and revocations are also audit-logged. The flag system provides a complete logical access change record for all flag-controlled production behavior.

**Evidence for audit:** Audit log export (CSV or JSON) filtered by action types `flag.update`, `flag.delete`, `access.grant` for the audit period. Management API RBAC role assignments report.

---

### GDPR Article 22

**Requirement:** If automated processing produces decisions that significantly affect individuals, those decisions must be documented and individuals have the right to explanation.

**Flag system implication:** If a feature flag controls whether a user receives a price, loan offer, content ranking, or access decision, changes to that flag's targeting rules are records of automated decision-making. The audit log of those changes is a required GDPR record.

**Control:** Tag flags that affect automated decisions with a `gdpr-art22: true` metadata field. Include these flags in GDPR record retention policy (minimum retention: 3 years or duration of potential dispute, whichever is longer). The audit log retention for GDPR-tagged flags is subject to GDPR data retention requirements — consider separately bucketed audit storage with appropriate retention policies.

---

### PCI DSS

**Requirement:** Security controls (WAF, authentication, rate limiting, fraud detection) must be operated within a change management process. Unauthorized changes to security controls are a critical finding.

**Flag system implication:** If any security control is gated or tunable via a feature flag, the flag system is now inside PCI scope. Specifically:

- Kill switch flags that can disable WAF rules, authentication requirements, rate limiting, or fraud detection must be restricted to the Security team role only. On-call engineers must **not** have access to flip these kill switches without security team approval.
- Any flag that touches a PCI-scoped system requires the same change management process as a code change: ticket, review, approval.
- Consider a separate "security flags" namespace with a separate RBAC tier and audit log stream going directly to the security team's SIEM, not the general engineering audit log.

**Anti-pattern in PCI environments:** Using feature flags as a fast-path to modify security behavior because they are faster than a code deploy. This is exactly the behavior PCI change management controls are designed to prevent.

---

## Security Review Checklist

Before deploying or modifying the flag management system, review the following:

- [ ] Management API authentication: all write endpoints require a valid, non-expired bearer token tied to an RBAC role
- [ ] Management API authorization: write operations verify the caller's role has write or admin permission; read operations verify reader-or-above
- [ ] SDK keys are read-only: verify SDK API keys cannot call any write endpoint (flag creation, targeting rule update)
- [ ] SDK keys are stored in secrets manager: no SDK key appears in container definitions, ConfigMaps, or version-controlled config files
- [ ] Audit log is insert-only: verify no UPDATE or DELETE path exists in the audit log data model; verify S3 Object Lock or equivalent is enabled
- [ ] SIEM export: audit log records are exported to SIEM within 24 hours of creation
- [ ] PII validation: management API rejects targeting rules containing email patterns or known PII field names
- [ ] No flag checks in authorization code paths: confirm via grep that no `flagClient.evaluate()` call appears in auth middleware, permission checks, or RBAC enforcement logic
- [ ] Kill switch pre-provisioning: verify on-call rotation members have the required role to flip kill switches — test this monthly in a non-production environment
- [ ] Security-scoped flags are RBAC-restricted: any flag that controls a security control is restricted to the Security team role and not writable by general engineering
- [ ] Quarterly key rotation: verify SDK key rotation is scheduled and has a runbook; last rotation date is within 90 days
- [ ] PCI-scoped flag change management: any change to a PCI-scoped flag has a corresponding change ticket and approval record linked in the audit log `changeReason` field
