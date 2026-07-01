# Security Architecture — Caching Strategies

## Threat Model

The cache is a secondary data store that often holds exactly the same sensitive data as the primary database — but with weaker access controls by default.

Authorization is applied at the application layer. The cache does not understand tenants, roles, or permissions. It stores and returns bytes keyed by a string. Any service with network access to the Redis endpoint can read any key, regardless of which tenant's data it contains or what access controls the originating service enforces.

This is the fundamental security asymmetry of caching: your database enforces row-level access controls, column-level encryption, and audit logging. Your Redis cluster, without deliberate controls, enforces none of these. A single compromised service with Redis network access can enumerate and read every cached value across every tenant.

```
Application Layer  →  enforces auth, validates caller identity, applies tenant isolation
        ↓
Cache Layer        →  stores and returns bytes; no auth understanding without explicit controls
        ↓
Database Layer     →  enforces ACLs, column encryption, audit logs, connection-level identity
```

The cache sits between these layers. It inherits none of the database's controls unless you explicitly add them.

---

## Attack Surface

| Attack Surface | Threat | Severity |
|---|---|---|
| **Cache key enumeration** | Attacker with read access predicts key patterns (e.g., `user:{id}:profile`) and iterates over known or guessable IDs to read other tenants' cached data | Critical |
| **Missing tenant prefix in key** | Multi-tenant service caches `product:{id}` instead of `{tenant_id}:product:{id}`; tenant A reads tenant B's product data from a shared cache | Critical |
| **PII in cache without encryption** | Cache dump, Redis MONITOR output, or network interception exposes PII stored as plaintext cached values | Critical |
| **Cache poisoning via write access** | Service with write access to a shared Redis namespace injects malicious cached values that other services read and trust without re-validation | High |
| **Unauthorized Redis access** | Redis port exposed on a network where more services can reach it than should be able to; no AUTH configured on the Redis instance | High |
| **Cache flooding** | Attacker or misconfigured client floods Redis with large or numerous keys, filling memory and triggering eviction of legitimate data | High |
| **Thundering herd after targeted eviction** | Attacker who can issue `DEL` commands (or knows TTL expiry timing) forces a simultaneous cache miss for a high-traffic key, causing a stampede to the origin database | High |
| **Sensitive data in negative cache** | A "not found" response is cached without checking whether the resource exists for this caller. A different caller who does have access gets a false "not found" from the cache. | Medium |
| **Serialized object injection** | If cache values are deserialized using language-native serialization (Java ObjectInputStream, Python pickle), an attacker who can write to Redis can inject a malicious payload that executes on deserialization | Medium |
| **Auth decision caching** | Caching the result of an authorization check (`user:123:can_access:resource:456 = true`) means the cache is now an access control store without the security properties of your IAM system. A cached "allow" survives a permission revocation until TTL expiry. | Medium |

---

## Controls

### Key Design Controls

The most important security control in caching is also the most basic: the key schema must encode tenant identity as its first segment, enforced by the shared cache client library.

```
# Required: tenant isolation at key prefix level
{tenant_id}:{namespace}:{entity_type}:{entity_id}

# Example — correct
acme_corp:orders:order:ord_8a91f3b2

# Example — dangerous (missing tenant prefix in multi-tenant service)
order:ord_8a91f3b2
```

The platform's shared cache client library must:
1. Accept `tenant_id` as a required parameter for all cache operations in multi-tenant contexts
2. Prefix all keys automatically — callers cannot bypass this
3. Reject operations that include a tenant prefix that doesn't match the caller's authenticated identity

**Never allow cross-namespace reads.** A service's cache client should be scoped to its own namespace. A query for `{other_team_namespace}:{key}` should fail at the client library level.

### PII Handling

Never store PII fields in plaintext cache values, even if Redis is encrypted at rest. Encryption at rest protects against storage-layer compromise; it does not protect against a compromised application that can issue GET commands.

For cached objects containing PII:
- Encrypt PII fields individually before caching, using a data encryption key (DEK) stored in a secrets manager
- Cache the encrypted value; decrypt on read
- Alternatively: cache only non-PII fields; fetch PII from a secured store on read (accepts the latency cost)

Fields that must be encrypted before caching: email addresses, phone numbers, SSNs, dates of birth, payment card data (PAN must never be cached in Redis under any circumstances — see PCI section below), government IDs, health data (PHI), and any other data classified as PII or sensitive under your data classification policy.

### Access Controls

| Control | Requirement |
|---|---|
| Redis AUTH | Required on all non-local instances. Use Redis ACL (Redis 6+) to restrict commands per client: application clients get `GET`, `SET`, `DEL`, `EXPIRE`; no `KEYS`, `SCAN` (or scope to their namespace only), no `FLUSHDB`, no `DEBUG` |
| Network access | Redis port (6379 / 6380 TLS) must not be reachable from the internet or from services that have no caching relationship. Use VPC security groups or network policies to restrict to known service CIDRs only. |
| Separate clusters per environment | Dev, staging, and production Redis must be separate clusters with separate credentials. Never share an AUTH token across environments. |
| No authorization decisions in cache | Cache data; enforce auth at the application layer on every read from cache. If user A's cached data is in the cache and user B's request hits the same key somehow, the application layer must detect and reject this — not the cache. |

---

## Transport Security

| Control | Requirement |
|---|---|
| **TLS in transit** | All Redis connections must use TLS. Redis 6+ supports native TLS. For older versions, use stunnel. Never transmit Redis protocol in plaintext over a network, even a private one. |
| **TLS version** | TLS 1.2 minimum; TLS 1.3 preferred |
| **Internet exposure** | Redis must never be reachable from the internet. This is a hard requirement, not a preference. A Redis instance exposed to the internet without AUTH is a critical vulnerability that is actively exploited. |
| **VPC-only access** | Redis endpoint must be reachable only within the VPC or via a VPN/private link. Security group or network policy must allowlist only known application service CIDRs. |
| **mTLS for high-sensitivity environments** | For environments where zero-trust network architecture is enforced, Redis connections should use mTLS with short-lived client certificates issued by an internal CA |

---

## Compliance Requirements

### GDPR (Right to Erasure)

A user's right to erasure cannot be satisfied by waiting for TTL expiry. If a user exercises the right to erasure, all cached representations of their personal data must be invalidated immediately.

Requirements:
- All keys containing a given user's PII must be discoverable and evictable programmatically
- The erasure path must be documented, tested, and included in the data deletion workflow
- Using `SCAN` with a user-scoped key pattern at erasure time is acceptable; key design must make this scan possible (user ID must be part of the key schema)
- Negative TTL caching of user data must respect the erasure: if a "user profile" is cached for 5 minutes, erasure must evict it, not wait for TTL

### SOC 2 CC6.1

Demonstrating that access to cached PII is controlled requires:
- Redis AUTH configured on all instances (verifiable in infrastructure-as-code)
- Network access restricted to documented service accounts (verifiable via security group rules)
- Audit log of Redis provisioning and credential rotation
- Evidence that PII fields are encrypted before caching (code review or automated policy check)

### PCI DSS

**Never cache PANs (Primary Account Numbers) or CVVs in a shared cache.** PCI DSS explicitly prohibits storing sensitive authentication data (CVV, PIN) after authorization. PANs must be stored with strong cryptography; placing them in Redis — even encrypted — expands the PCI scope of your Redis cluster to PCI Level 1, triggering full audit requirements for the cache tier.

If payment data flows through your application layer, ensure cache values for payment-adjacent operations (order totals, payment status) contain only non-sensitive fields.

---

## Security Review Checklist

Before deploying any service that introduces caching:

- [ ] Cache key schema includes tenant ID as the first segment in all multi-tenant services
- [ ] PII fields are encrypted before being written to cache; not just relying on transport or at-rest encryption
- [ ] Redis AUTH is configured; credentials are stored in a secrets manager (not in environment variables or config files)
- [ ] Redis port is not reachable from the internet; security group / network policy is reviewed and documented
- [ ] Redis ACL limits application clients to `GET`, `SET`, `DEL`, `EXPIRE`, `PEXPIRE`, and `EXPIREAT` only (no `FLUSHDB`, `KEYS`, `DEBUG`)
- [ ] Negative caching is scope-aware: a "not found" cached for user A does not prevent user B from accessing the same resource if user B has permission
- [ ] Auth decisions are NOT cached; only data is cached; authorization is enforced at the application layer on every read
- [ ] GDPR erasure path is documented and tested: given a user ID, which keys are evicted and by what mechanism
- [ ] Serialization format does not use language-native object serialization (no Python pickle, Java ObjectInputStream) — use JSON, MessagePack, or Protobuf
- [ ] Dev and staging Redis clusters are separate from production; credentials are separate
