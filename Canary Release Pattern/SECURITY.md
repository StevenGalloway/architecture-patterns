# Security Architecture — Canary Release Pattern

## Threat Model

Canary releases introduce a unique attack surface that does not exist in single-version deployments: a window of time when two versions of a system run simultaneously, traffic routing can be influenced, and the automated analysis that drives promotion decisions becomes a trust boundary.

The canary pattern's core value proposition — progressive exposure of a new version to real production traffic — is also its principal security concern. Real production traffic flowing to an unproven version, with automated systems making the call to expose more users, means the security of the promotion decision is as important as the security of the code being promoted.

---

## Attack Surface

| Attack Surface | Threat | Severity |
|---|---|---|
| **Traffic routing manipulation** | An attacker who knows a vulnerability exists in the canary version can steer their own requests toward it by exploiting session affinity, geographic routing, or load balancer behavior. The canary is intentionally serving a subset of users — targeted exploitation before rollback is possible. | High |
| **Analysis metric poisoning** | A compromised service or observability component injects artificially favorable metrics into the analysis pipeline, causing a vulnerable or malicious build to pass analysis gates and be promoted to 100% of traffic. | High |
| **Secrets and credentials in canary version** | A new version accidentally logs credentials, API keys, or session tokens in responses or structured logs. The canary version serves 5% of users before detection, exposing their data. | High |
| **Rollback mechanism failure** | Automated rollback fails silently — the analysis correctly identifies a regression, issues a rollback signal, but the Rollout controller fails to execute it. The canary version remains at 5% traffic indefinitely with no human awareness. | High |
| **CI/CD pipeline compromise leading to canary promotion** | An attacker compromises the CI/CD pipeline and introduces malicious code. The canary promotion pipeline, if it has elevated Kubernetes RBAC permissions, becomes the mechanism for deploying and promoting the malicious version. | Critical |
| **Version incompatibility data corruption** | The canary version writes records to a shared database using a different schema or encoding than the stable version. The stable version reads those records and produces incorrect behavior or corrupts downstream data. This is a correctness issue, but data corruption has security implications in financial and healthcare contexts. | High |
| **Analysis window bypass** | The canary analysis window is configured too short (2 minutes) to detect security-relevant behavioral changes: slow data exfiltration, authentication bypass that only triggers on specific request patterns, or session fixation that requires multiple requests to manifest. | Medium |
| **Canary targeting as reconnaissance** | An attacker probes the system to determine which users are receiving canary traffic (via response headers, timing differences, or behavioral differences) to map the new version's attack surface before it reaches 100%. | Medium |

---

## Security Controls

### Traffic Routing

Canary versions must operate under the same network security policies as stable versions. There is no "canary network zone" with relaxed controls:
- Network policies in Kubernetes must apply identically to stable and canary pod sets
- Canary pods must not have elevated IAM roles or relaxed security group rules to "make testing easier"
- If the stable version uses mTLS to downstream services, the canary version must also use mTLS — not because the canary might be compromised, but because deploying it without mTLS creates a config inconsistency that persists after promotion

Response headers must not leak version information to clients. Do not add `X-Canary-Version: true` or similar headers to canary traffic — this directly enables targeted exploitation of known vulnerabilities in the canary build.

### Secrets and Credentials

Canary deployments must use the same secrets management approach as production:
- Canary pods pull secrets from the same Vault path or Secrets Manager ARN as stable pods
- Never provision separate credentials for canary that bypass production access controls ("canary API keys" with broader permissions are a common mistake during canary setup)
- New secrets introduced by the new version (new third-party integrations, new database credentials) must be provisioned through the same secrets management workflow — not as environment variables or hardcoded values "just for the canary test"

### Analysis Pipeline Integrity

The analysis runner that queries metrics and makes the promote/rollback decision is a trust boundary. Controls:
- The analysis runner must authenticate to the metrics platform using a service account with read-only permissions to metric queries — it should not be able to write metrics
- AnalysisTemplate changes must go through the same code review process as application code — a too-permissive threshold change is a security control change
- Analysis results (the pass/fail decision and the metric values that drove it) must be immutably logged — they are change management records
- The rollback automation must be tested on a separate cadence from canary promotion testing. Knowing that promotion works does not tell you that rollback works.

### CI/CD Pipeline Security

The CI/CD pipeline that triggers canary deployments has elevated Kubernetes RBAC permissions (it needs to update Rollout resources). This makes it a high-value target:
- Pipeline credentials must be scoped to the minimum required RBAC: ability to update the specific Rollout resource for the service being deployed, nothing broader
- Pipeline jobs must require code review approval before executing a production deployment — the same approval process applies to the canary's initial step as to any production change
- Artifact signing: container images that enter the canary promotion pipeline must be signed and the signature verified by the Rollout controller before traffic is shifted. An unsigned image should not be promotable.

---

## Compliance

### SOC 2 Change Management

Canary releases are a form of controlled change. The SOC 2 CC8.1 change management control requires that production changes are authorized, tested, and documented. Canary automation satisfies this if:
- The promotion decision is auditable: who or what decided to promote, based on which metrics, at what values, at what time
- The rollback decision is auditable: same requirements
- The analysis configuration (AnalysisTemplate) is version-controlled and change-reviewed

The canary analysis log (see Observability section) serves as the change management audit trail. Retain these logs for the same period as other change records (typically 1 year for SOC 2).

### PCI DSS

For services that process cardholder data, PCI DSS Requirement 6.3 (security vulnerabilities addressed) and 6.5 (change and patch management) apply:
- Changes to code in the cardholder data environment (CDE) must follow an authorization process. Automated canary promotion counts as an authorization — but the analysis gate must include security-relevant metrics, not just latency and error rate.
- PCI DSS 6.3.2 requires an inventory of bespoke and custom software. Canary deployments introduce a temporary second inventory entry — the canary version running at N% traffic. Automated tooling must reflect both versions in the software inventory during the canary window.
- Penetration testing scope: if a PCI DSS penetration test occurs during a canary window, both the stable and canary versions are in scope. Notify the pen test team if a canary is active during the test window.

### GDPR

If 5% of user requests are routed to a new version that processes personal data differently, and that version has a data handling regression, GDPR Article 33 breach notification requirements may apply. The canary rollback automation must be treated as a data protection control, not just an operational one.

---

## Security Review Checklist

Before any canary configuration change reaches production:

- [ ] Canary pod security context matches stable pod security context (same securityContext, runAsNonRoot, readOnlyRootFilesystem settings)
- [ ] No version-identifying headers added to canary responses (no `X-Canary: true` or `X-Version: 2.1.0` headers)
- [ ] Canary pods pull secrets from the same Vault/Secrets Manager paths as stable pods — no separate "canary credentials"
- [ ] AnalysisTemplate includes security-relevant metrics: auth failure rate (4xx by type), anomalous response body size (potential data exfiltration), 403 rate increase (potential authorization regression)
- [ ] Container image entering canary promotion pipeline is signed and signature verified
- [ ] CI/CD pipeline RBAC is scoped to the minimum required to update the specific service's Rollout resource
- [ ] AnalysisTemplate change has gone through the standard code review process — threshold changes are security control changes
- [ ] Rollback automation tested independently within the last 30 days — a passing canary test does not validate rollback
- [ ] Analysis log retention policy is set to comply with change management audit requirements
- [ ] Database schema changes in the new version are backward compatible with the stable version (prevents data corruption during canary window)
