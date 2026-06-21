# Security Architecture — API Gateway Pattern

## Threat Model

The API Gateway is the externally-facing boundary of your system. Every security control that fails here fails for all services simultaneously. This concentration of responsibility is both its strength (one place to harden) and its largest risk (one misconfiguration affects everything).

### Attack Surface

```
Internet → WAF → API Gateway → Internal Services
              ↑                      ↑
         (perimeter)           (trust boundary)
```

| Attack Surface | Threat | Severity |
|---|---|---|
| JWT validation | Forged or replayed tokens bypass authentication | Critical |
| Routing config | Misconfigured route exposes unintended upstream | Critical |
| Identity header injection | Attacker spoofs `X-User-ID` header to internal service | Critical |
| Rate limit bypass | Distributed clients evade per-IP or per-tenant limits | High |
| WAF gap | Request crafted to bypass WAF rules before reaching gateway | High |
| TLS configuration | Downgrade attack or weak cipher suite | High |
| SSRF via routing | Attacker-controlled input in routing rule causes SSRF | High |
| Log PII leakage | User emails, IPs, or tokens captured in access logs | Medium |
| Gateway config injection | CI/CD pipeline compromise pushes malicious routing rule | Medium |
| Dependency vulnerability | Gateway process itself runs a vulnerable library | Medium |

---

## Authentication Controls

### JWT Validation Requirements

The gateway must validate all of the following on every inbound JWT before forwarding to an upstream:

| Claim | Validation | Failure response |
|---|---|---|
| `alg` | Must match allowed algorithms (RS256, ES256). Reject `none` and symmetric algorithms (HS256 is acceptable only for internal services). | 401 |
| `iss` | Must match your IdP's issuer URL exactly. Reject if missing or unexpected. | 401 |
| `aud` | Must include your API gateway's audience identifier. Reject if missing or wrong audience. | 401 |
| `exp` | Must be in the future. Reject expired tokens. Allow ≤30 second clock skew. | 401 |
| `nbf` | If present, must be in the past. | 401 |
| Signature | Verify against JWKS. Cache JWKS with 5-minute TTL. On 401 from upstream, invalidate and re-fetch once. | 401 |

**Never:**
- Accept `alg: none`
- Trust the `kid` header to select an algorithm (attacker-controlled)
- Re-validate the JWT in upstream services (creates inconsistency — see ADR-002)

### JWKS Key Rotation

Key rotation must not cause an outage. Protocol:
1. IdP publishes new key alongside old key in JWKS (overlap period: minimum 24 hours)
2. Gateway caches both keys; validates against all current keys
3. Old key removed from JWKS after all tokens signed with it have expired
4. Gateway cache invalidation is automatic on TTL; no deployment required

---

## Authorization Boundaries

The gateway enforces **authentication** (is this a valid identity?) and **coarse-grained authorization** (is this client type allowed to call this route at all?).

It does **not** enforce fine-grained authorization (can this user see this specific resource?). That belongs in the service.

| Layer | Enforced at | Example |
|---|---|---|
| Authentication | Gateway | Valid JWT with correct issuer and audience |
| Route-level authorization | Gateway | Partner API clients cannot call `/admin/*` routes |
| Resource-level authorization | Service | User can only read their own orders |
| Field-level authorization | Service | Free-tier users cannot see `margin_data` field |

Centralizing resource-level auth at the gateway couples it to every service's domain model. A permission schema change in any service requires a gateway deployment. Reject this pattern.

---

## Identity Header Security

The gateway extracts claims from the validated JWT and forwards them as HTTP headers to upstream services (e.g., `X-User-ID`, `X-Tenant-ID`, `X-Roles`). Upstream services trust these headers.

This is safe **only if** the gateway is the sole entry point and direct access to upstream services from outside the private network is blocked.

**Required controls:**
1. Upstream services run in a private subnet with no internet-facing ingress
2. Security group / network policy: only the gateway's security group may reach upstream services on their API port
3. Gateway strips any `X-User-ID`, `X-Tenant-ID`, `X-Roles` headers from *inbound* client requests before forwarding — clients must not be able to inject these
4. Document this as a hard prerequisite in ADR-002 and verify it in the security review checklist

**Failure mode:** If a developer opens a service's port directly for debugging and forgets to close it, an attacker can call that service with spoofed identity headers. Automate port scanning in CI to detect this drift.

---

## Transport Security

| Control | Requirement |
|---|---|
| TLS version | TLS 1.2 minimum; TLS 1.3 preferred |
| Cipher suites | ECDHE + AES-GCM or ChaCha20-Poly1305. Disable RC4, 3DES, CBC-mode ciphers. |
| Certificate | Public CA cert for external-facing gateway. Automated renewal (ACM, Let's Encrypt). |
| HSTS | `Strict-Transport-Security: max-age=31536000; includeSubDomains` on all responses |
| Gateway → upstream | TLS or mTLS if services are in separate trust zones. Plain HTTP is acceptable within the same private subnet only if network controls are verified. |
| Certificate pinning | Not recommended at gateway layer (operationally fragile on rotation). Use mTLS with short-lived certs instead. |

---

## WAF Configuration

The WAF sits in front of the gateway and blocks common attack patterns before they consume gateway resources.

**Minimum WAF rules:**
- OWASP Core Rule Set (CRS): SQL injection, XSS, path traversal, command injection
- Rate-based rules: block IPs exceeding X requests/second at WAF layer (coarse; gateway handles tenant-level rate limiting)
- Geo-blocking: if your business does not serve certain regions, block at WAF
- Known malicious IPs: subscribe to threat intelligence feed

**What WAF does not replace:**
- JWT validation (WAF cannot validate cryptographic signatures)
- Business logic rate limiting (WAF rate limits are IP-based; tenant-level limits require gateway context)
- Authentication (WAF can block obviously malformed tokens but cannot verify signatures)

---

## Secrets and Credential Management

| Secret | Storage | Rotation |
|---|---|---|
| JWKS signing keys | Managed by IdP (Auth0, Okta, or internal). Gateway fetches via JWKS endpoint. | Automatic via IdP. Gateway handles via cache TTL. |
| Upstream service credentials (if any) | AWS Secrets Manager or HashiCorp Vault. Never environment variables in container definitions. | Automated rotation with zero-downtime swap. |
| TLS private key | AWS Certificate Manager (preferred) or Vault PKI. | Automated renewal ≥30 days before expiry. |
| WAF API credentials | Secrets Manager. | Annual or on personnel change. |
| Gateway admin credentials | SSO + MFA only. No shared service accounts. | On personnel change; audit log required. |

---

## Compliance Relevance

| Standard | Gateway's role |
|---|---|
| **SOC 2 CC6.1** | Gateway provides the audit log of all external access attempts. Must log auth failures with enough context to investigate. |
| **SOC 2 CC6.6** | Network controls (private subnet, security groups) enforced at gateway boundary. |
| **PCI DSS Req 6.4** | WAF is explicitly required for cardholder data environments. |
| **PCI DSS Req 7** | Gateway enforces route-level access control (partners cannot reach internal admin routes). |
| **GDPR Art. 32** | Access logs must not contain PII in plaintext. Hash or omit IPs; do not log email addresses. |
| **GDPR Art. 30** | Gateway access logs may count as processing records; retention policy must be documented. |

---

## Security Review Checklist

Before any gateway change reaches production:

- [ ] JWT validation covers `alg`, `iss`, `aud`, `exp`, and signature
- [ ] `alg: none` is explicitly rejected
- [ ] Inbound identity headers (`X-User-ID`, `X-Tenant-ID`) are stripped before forwarding
- [ ] New routes are default-deny (require explicit auth unless marked public)
- [ ] Upstream services are not reachable except via gateway (verified by network policy test)
- [ ] No credentials or secrets in gateway config files or environment variable definitions
- [ ] Access log schema excludes PII fields
- [ ] WAF rules updated if new route introduces new input patterns
- [ ] TLS config passes current OWASP TLS Cheat Sheet recommendations
- [ ] Dependency scan (npm audit / Snyk) run against gateway codebase
