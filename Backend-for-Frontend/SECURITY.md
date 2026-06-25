# Security Architecture — Backend-for-Frontend Pattern

## Threat Model

The BFF introduces a security surface that is distinct from both the API Gateway and the domain services it calls. The BFF's position — between external clients and internal domain services — means it holds two trust contexts simultaneously: it is a trusted internal caller to domain services, and it is an externally-facing service to end users. Getting either context wrong creates vulnerabilities that neither the API Gateway nor the domain services will catch.

The BFF also introduces a concentration risk: one BFF serves all users of one client type. A compromised mobile BFF does not expose one user — it exposes every mobile user's session.

### Attack Surface

```
Mobile Client ─────► Mobile BFF ─────► Domain Services
                         │                  (Profile, Orders,
Web Client ──────► Web BFF           Catalog, Inventory,
                         │             Recommendations)
                    ┌────┴────┐
               Trust: client       Trust: internal service
               (must validate)     (BFF is caller; must not forge)
```

| Attack Surface | Threat | Severity |
|---|---|---|
| JWT forwarding bypass | BFF forwards JWT to domain services without validating it first; a compromised BFF or SSRF vulnerability can forge identity headers downstream | Critical |
| PII overexposure per client surface | BFF returns PII fields the mobile app never renders (full address, date of birth, account history); data is transmitted to mobile devices where it can be intercepted, logged, or extracted by a compromised app | Critical |
| BFF as amplification target | One inbound request to the BFF triggers 5–8 downstream domain calls; a DDoS attack on the BFF is amplified 5–8× against the internal domain service network | High |
| Session compromise blast radius | BFF holds session context for all users of that client type; a session fixation or session hijacking vulnerability affects all current sessions, not one user | High |
| Cross-client data leakage | Web BFF accidentally exposes a field (e.g., `account_tier`, `margin_data`) that is only permitted on the admin portal BFF; field-level access control is not enforced at the domain service layer | High |
| Dependency confusion via shared library | BFF imports a platform-team-owned shared library; a malicious or compromised version of that library compromises every BFF that consumes it | High |
| Partial response information leakage | When a domain service call fails, BFF returns a partial response; error metadata in the partial response (upstream service name, error type) provides an attacker with internal topology information | Medium |
| BFF-to-domain service credential exposure | BFF calls domain services with service-to-service credentials (mTLS cert, API key); if credentials are stored in environment variables or config maps, a container escape exposes them | Medium |
| Log PII leakage at BFF layer | BFF logs assembled response bodies that contain PII (user email, order history, address); log ingestion pipeline becomes a PII exfiltration path | Medium |
| Stale JWT propagated to domain services | BFF caches a user session and re-uses the JWT beyond its expiry; downstream domain services receive a technically expired token if they re-validate | Low |

---

## JWT Validation at the BFF Layer

The BFF must validate the JWT itself. It must not forward the raw JWT to domain services and rely on domain services to validate it. This is the most commonly skipped control, and its absence is the most severe vulnerability the pattern introduces.

**Why forwarding without validation is dangerous:**

If the BFF validates nothing and passes the JWT header directly to domain services, an attacker who can make the BFF issue an outbound request to a domain service (via SSRF, request smuggling, or a compromised BFF process) can forge the `Authorization` header with any identity. The domain services, receiving a request from the trusted BFF network address, have no independent basis to distinguish a legitimate forwarded token from a forged one.

**Validation requirements at the BFF layer:**

| Claim | Validation | Failure response |
|---|---|---|
| `alg` | Reject `none` and any symmetric algorithm (HS256) not explicitly permitted. Accept RS256, ES256. | 401 to client |
| `iss` | Must match your IdP's issuer URL exactly. | 401 to client |
| `aud` | Must include the audience identifier for this BFF's client type. Mobile BFF and Web BFF should have distinct audience claims. | 401 to client |
| `exp` | Must be in the future. Allow ≤30 second clock skew. | 401 to client |
| Signature | Verify against JWKS endpoint. Cache JWKS with 5-minute TTL. On downstream 401, invalidate and re-fetch once. | 401 to client |

After validation, the BFF extracts identity claims (`user_id`, `tenant_id`, `roles`) and forwards them as internal identity headers to domain services. The raw JWT is not forwarded. Domain services trust internal identity headers from BFF network addresses only.

**BFF-specific requirement:** each BFF should be registered with a distinct `aud` claim. This means a token issued for the mobile BFF cannot be replayed against the web BFF, and vice versa.

---

## PII Overexposure Controls

The BFF's job is to shape responses for its client. This shaping must include an explicit allowlist of fields the client actually uses. Fields the client does not render must not be returned, even if the domain service provides them.

**Why PII overexposure is a BFF-specific risk:**

Domain services return full objects because they serve multiple consumers. The Orders service returns order items, shipping addresses, payment method metadata, and internal processing flags. The mobile app renders order status and tracking number. If the BFF passes the full Orders response to the mobile client, the mobile device receives payment method metadata and shipping addresses for every order — data the app never uses and the user did not expect to transmit to a mobile device.

On mobile devices, this data can be:
- Intercepted on a compromised network before TLS termination (jailbroken device, custom trust store)
- Logged by the mobile app's crash reporting SDK (which may be a third-party service)
- Extracted from device memory or backups

**Control: response allowlists per client surface**

Each BFF endpoint must define an explicit projection of the response. This projection is not optional and should be enforced by schema validation, not by developer discipline.

```javascript
// Correct: explicit allowlist per endpoint
const mobileOrderProjection = {
  order_id: true,
  status: true,
  tracking_number: true,
  estimated_delivery: true
  // shipping_address: NOT included
  // payment_method: NOT included
  // internal_flags: NOT included
};

// Incorrect: pass-through with minor modification
const mobileOrderProjection = {
  ...ordersServiceResponse,
  _internal_flags: undefined  // one field removed, all others pass through
};
```

The allowlist approach means that when the Orders service adds a new field (e.g., a B2B-specific field for a new feature), it does not automatically appear in mobile or web responses. The BFF must explicitly include it. This is the desired behavior — it prevents the class of incident described in this pattern's ADR where a domain service schema change broke client apps.

**GDPR implication:** The BFF is the point where PII minimization is enforced. Each BFF's response schema is a statement of what PII that client surface is authorized to receive. This schema should be reviewed by the Data Protection Officer as part of any new BFF launch.

---

## Amplification Attack Controls

The BFF's aggregation capability is also its amplification surface. An attacker who can issue requests to the BFF at a rate sufficient to trigger rate limiting responses can simultaneously generate 5–8× that request rate against internal domain services, which have no rate limiting of their own (they trust BFF traffic).

**Controls:**

| Control | Description |
|---|---|
| Rate limiting at BFF layer per authenticated user | Limit authenticated requests per `user_id`, not just per IP. A single user flooding the BFF generates amplified traffic on all domain services the BFF calls for that endpoint. |
| Rate limiting per endpoint (fanout-aware) | High-fanout endpoints (home screen: 6 domain calls) should have lower rate limits than low-fanout endpoints (user settings: 1 domain call). The limit should reflect downstream load, not just client request volume. |
| Connection pool limits per domain service | The BFF's connection pool to each domain service is bounded. Even if the BFF receives a flood of requests, the domain service call rate is capped by the pool. Configure pool size based on domain service capacity, not BFF throughput. |
| Circuit breaker per upstream service | If one domain service becomes unavailable, the BFF stops calling it and serves partial responses. This prevents the BFF from holding open connections during a domain service outage, which would exhaust the connection pool and degrade all endpoints. |
| Domain service network policy | Domain services accept requests only from BFF network addresses (by security group or network policy). External traffic to domain services is blocked at the network layer, so even a fully compromised BFF cannot be used to flood domain services from outside the VPC. |

---

## Cross-Client Data Leakage

When multiple BFFs call the same domain services, there is a risk that one BFF's response shape exposes fields that should only be visible to a different client surface.

**Example:** The admin portal BFF returns `account_margin_data` from the Catalog service. The web BFF developer, referencing the admin BFF as a template, includes `account_margin_data` in the web response projection. Regular users can now see pricing margin data through the web app.

**Controls:**

- Field-level access control is enforced at the domain service layer by scoped credentials, not by BFF developer discipline. The admin BFF's service account has the `catalog:read:margin` scope; the web BFF's service account does not.
- Each BFF uses a distinct service identity (distinct client credentials, distinct mTLS certificate) for domain service calls. Domain services enforce scope-based field visibility: if the calling identity lacks the scope for a field, the field is omitted from the response.
- Security team conducts a response schema review for each new BFF endpoint at launch. This is the time-boxed review, not a per-PR gate.

---

## Dependency Confusion via Shared Library

The BFF pattern relies on a platform-owned shared library for cross-cutting concerns (JWT validation, request ID propagation, structured logging). This library is a dependency of every BFF in the organization. A malicious or compromised version of this library compromises every BFF simultaneously.

**Controls:**

| Control | Description |
|---|---|
| Private npm/pip registry | Shared library is published to a private package registry. It is not published to the public npm registry under a generic name. This prevents dependency confusion attacks where a public package with the same name is resolved first. |
| Exact version pinning with lock files | BFFs pin to an exact version (`1.4.2`, not `^1.4.2`). Lock files (package-lock.json, yarn.lock) are committed and checked in CI. A library update requires an explicit PR, not an automatic upgrade. |
| Checksum verification in CI | CI pipeline verifies the SHA-256 checksum of the installed library against a known-good value. A package that changes between release and installation triggers a build failure. |
| Code signing for library releases | Platform team signs library releases with a GPG key. BFF CI validates the signature before installing. |
| Automated dependency scanning | Snyk or Dependabot scans all BFFs weekly. Critical CVEs in the shared library trigger an automated PR to update all BFFs. |

---

## Deployment Credentials

Each BFF must have its own deployment credentials, separate from other BFFs and from domain services. A compromised deployment pipeline for one BFF must not be able to deploy to another BFF or to any domain service.

| Credential | Storage | Scope |
|---|---|---|
| BFF service account (for domain service calls) | AWS Secrets Manager or Vault | Scoped to that BFF's permitted operations. Mobile BFF service account cannot call admin-only domain service endpoints. |
| BFF deployment credentials (CI/CD) | GitHub Actions OIDC / AWS IAM role | Scoped to that BFF's ECS service and ECR repository only. Cannot deploy to web BFF or any domain service. |
| BFF TLS certificate | ACM or Vault PKI | Per-BFF certificate. Not a wildcard cert shared across BFFs. |
| mTLS client certificate (for domain services) | Vault PKI with short-lived certs (24-hour TTL) | Per-BFF identity. Domain services can distinguish which BFF is calling. |

---

## Compliance Relevance

| Standard | BFF's role |
|---|---|
| **GDPR Art. 5(1)(c) — Data minimisation** | BFF response allowlists are the mechanism for minimisation. Each BFF returns only the PII fields required by that client experience. This must be reviewed and documented per BFF launch. |
| **GDPR Art. 32 — Security of processing** | BFF-layer encryption in transit (TLS 1.2+), per-BFF service credentials, and response allowlists collectively constitute appropriate technical measures. |
| **SOC 2 CC6.1** | Each BFF maintains its own structured access log, showing which authenticated user accessed which endpoint via which client surface. The client surface is a material audit detail: the same user accessing data via the admin portal BFF vs. the mobile BFF is a different risk profile. |
| **SOC 2 CC6.6** | Domain services are not accessible except via BFF network addresses. This is the internal network boundary control. Verified by network policy tests in CI. |
| **PCI DSS Req 3.3** | Cardholder data returned by domain services must be masked or omitted in BFF response projections unless the client surface is explicitly authorized for cardholder data access. Mobile BFF must not return full card numbers even if the Payments service provides them. |

---

## Security Review Checklist

Before a new BFF or new BFF endpoint reaches production:

- [ ] JWT validation implemented using platform-owned auth middleware library (not custom implementation)
- [ ] BFF validates `alg`, `iss`, `aud`, `exp`, and signature before forwarding identity claims
- [ ] Distinct `aud` claim configured for this BFF's client type
- [ ] Response allowlist defined for every endpoint (allowlist, not blocklist)
- [ ] No PII fields returned that the client app does not render (confirmed with frontend team)
- [ ] Per-endpoint rate limits configured, with fanout ratio considered
- [ ] Distinct service identity (credentials, mTLS cert) provisioned for this BFF
- [ ] Domain service network policy updated to permit this BFF's network address
- [ ] Shared library pinned to exact version with checksum verification
- [ ] BFF deployment credentials scoped to this BFF's resources only
- [ ] Access log schema excludes response body content
- [ ] Partial response error metadata does not expose internal service names to clients
- [ ] Security team response schema review completed (at launch; not per-PR)
