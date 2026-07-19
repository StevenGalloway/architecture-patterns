# Security Architecture — Distributed Cache Invalidation

## Threat Model

Distributed cache invalidation creates a messaging channel between write services and cache consumers. This channel can be exploited in ways that traditional request/response security models do not account for:

- An attacker who can **publish** to the invalidation topic can flush caches (availability impact via thundering herd)
- An attacker who can **suppress** invalidation events can cause stale data to persist indefinitely (data integrity impact)
- An attacker who can **read** the invalidation topic can enumerate all cached entity IDs without querying the API (information disclosure)

The invalidation pipeline is a side channel that exists outside the standard API authentication boundary. It requires its own security controls, independent of the controls that protect the API endpoints themselves.

---

## Attack Surface

| Attack Surface | Threat | Severity |
|---|---|---|
| **Unauthorized invalidation event publication** | Attacker floods `cache.invalidation.*` topics, evicting all cache entries simultaneously. All instances experience thundering herd — every subsequent request misses cache and hits origin database. Database saturation causes service degradation or outage. | High |
| **Selective invalidation suppression** | Attacker suppresses invalidation events for specific entity IDs (e.g., a product price or a user's permission set). Targeted stale data persists in all caches until TTL expiry. Business impact depends on the entity: suppressing a price change invalidation causes all instances to serve the wrong price for up to 60 seconds. | High |
| **Cache key enumeration via invalidation events** | Invalidation events contain full key names (e.g., `prod:tenant_123:v2:product:456`). An attacker with read access to the NATS topic can enumerate all cached entity IDs, tenant IDs, and entity types without ever calling the API. This is a reconnaissance capability. | Medium |
| **PII in cache values without encryption** | If Redis is compromised (e.g., via a Redis AUTH bypass or a misconfigured public endpoint), all cached values are exposed. Invalidation does not protect data at rest — it only removes keys. Cache values containing PII, session data, or financial information must be encrypted at the application layer regardless of invalidation controls. | Critical |
| **Tenant key collision due to missing tenant prefix** | A key written without a tenant prefix (e.g., `product:456` instead of `tenant_123:product:456`) can be read by any other tenant's cache lookup. A cache consumer that constructs keys without tenant scope creates a cross-tenant data exposure path. | Critical |
| **Cache poisoning via write access** | An attacker with Redis WRITE access (e.g., via a compromised service account) injects a crafted value for a key. The legitimate write service publishes an invalidation event for that key — but the attacker immediately re-writes the poisoned value. The invalidation event evicts the legitimate value; the poisoned value survives until the next legitimate write. | High |
| **NATS authentication bypass** | If NATS is deployed without authentication, any process that can reach the NATS port (within the private network) can publish to any topic. A compromised internal service becomes an invalidation event publisher without restriction. | High |
| **Stale cache after security-relevant data change** | A user's permissions are revoked (account suspension, role change). The authorization decision is cached in L1 (60s TTL) and L2 (5-min TTL). If the permission change does not trigger an explicit invalidation event, the user retains access for up to 5 minutes after revocation. | Critical |

---

## Security Controls

### NATS Topic Access Control

NATS JetStream supports subject-based access control (authorization via credentials). Publishers and consumers must authenticate with credentials that scope them to specific subjects.

**Required configuration:**
- Write services: credentials that permit PUBLISH to `cache.invalidation.{entity_type}` only for entity types they own
- Cache consumers (API instances): credentials that permit SUBSCRIBE to `cache.invalidation.*` but not PUBLISH
- No shared credentials across services — each service has its own credential set
- NATS credentials stored in Secrets Manager or Vault; never in environment variable definitions

### Invalidation Events Must Not Contain Data Values

Invalidation events should contain only the keys to evict — never the new values. This is the evict-on-write policy documented in ADR-003.

**Why this matters for security:** if an invalidation event contains the new value (to avoid a cache miss after eviction), a compromised NATS consumer can reconstruct the data stream by reading the invalidation topic instead of querying the API. An attacker with topic read access gains a real-time feed of all data changes without ever authenticating to the API. Key-only events limit the blast radius of topic compromise to cache availability, not data confidentiality.

### Tenant ID as First Cache Key Element

Every cache key must include the tenant ID as the first element: `{env}:{tenant_id}:{version}:{entity_type}:{entity_id}`.

The platform cache library (see PLATFORM-ENGINEERING.md) enforces this at key construction time and will reject key registration that omits the tenant prefix. Direct Redis writes that bypass the platform library are prohibited by service account policy — platform library service accounts do not have WRITE permission on arbitrary key patterns.

### Security-Relevant Cache Entries

Cached authorization decisions (permission checks, role lookups, session tokens) must be treated differently from general entity caches:

| Cache type | L1 TTL | L2 TTL | Invalidation on change |
|---|---|---|---|
| General entity data (product, catalog) | 60s | 5 min | On write (ADR-003) |
| Authorization decisions | ≤10s | ≤30s | Required immediately on permission change |
| Session tokens | Do not cache | Do not cache | Not applicable |
| User-specific preferences | 30s | 2 min | On user update |

Permission revocations must publish an explicit invalidation event with the user's permission cache keys. A permission change that relies solely on TTL expiry is a security control failure, not a cache design decision.

### Redis Security Requirements

- Redis AUTH required (strong password, rotated quarterly)
- TLS encryption in transit between application and Redis (Redis 6+ with TLS support)
- Redis deployed in private subnet; no public endpoint
- Redis not accessible from internet-facing services directly — only via platform cache library
- Redis KEYS command disabled in production (prevents enumeration attacks and performance degradation)
- Redis ACL configured so each service's credentials can only read/write its own key namespace prefix

---

## Compliance Requirements

### GDPR Right to Erasure (Article 17)

GDPR right-to-erasure requires invalidation of all cached data for a user when an erasure request is processed. This must be a first-class invalidation event type in the platform.

**Required event:**
```json
{
  "event_type": "user.erasure",
  "user_id": "user_789",
  "tenant_id": "tenant_123",
  "erasure_scope": "all",
  "requested_at": "2025-11-26T14:23:01Z"
}
```

**Consumer behavior:** on receiving `user.erasure`, every API instance must scan its L1 cache for all keys containing `user_id=789` and evict them. The platform library provides a `evictByUserPattern(userId)` helper for this purpose. L2 Redis eviction uses `SCAN` with the pattern `*:user_789:*` to identify and delete all matching keys.

TTL expiry is not an acceptable substitute for GDPR erasure — "the data will be gone in 5 minutes" does not satisfy the right to erasure. Invalidation must be immediate.

### SOC 2 CC6.1 — Logical Access Controls

Invalidation events represent access control changes (permission revocations, session terminations). These events must be logged with enough context to reconstruct the timeline of any access control change:

- Which service published the invalidation event
- Which entities were invalidated
- When the event was published
- When each consumer processed the event (propagation latency)

The platform cache library emits structured logs for all invalidation events received and processed. These logs satisfy SOC 2 CC6.1 requirements for demonstrating that access control changes propagate promptly.

### HIPAA — PHI in Cache

Any service that caches Protected Health Information must:
1. Use application-layer encryption for cache values (not just Redis TLS)
2. Invalidate immediately on data deletion or correction — TTL expiry is not acceptable
3. Ensure cache key design does not expose PHI in the key itself (e.g., `patient:ssn:{value}` is prohibited — use opaque identifiers only)
4. Include PHI cache invalidation in the BAA scope when the shared Redis cluster is used

---

## Security Review Checklist

Before any cache invalidation change reaches production:

- [ ] NATS credentials scope publishers to their own entity types only; consumers cannot publish
- [ ] Invalidation events contain only keys, never values
- [ ] All cache keys include tenant ID as the first element; platform library enforces this at construction time
- [ ] Security-relevant cached data (permission decisions, role lookups) has TTL ≤ 10s in L1 and ≤ 30s in L2, with explicit invalidation on change
- [ ] `user.erasure` event type is registered and consumers implement `evictByUserPattern()` correctly
- [ ] Redis is not accessible from any public endpoint; only accessible via platform cache library
- [ ] Redis TLS and AUTH are configured; credentials are stored in Secrets Manager, not environment variables
- [ ] No PHI or PII in cache key names — only opaque identifiers
- [ ] Application-layer encryption is applied to any cache values containing PHI or PII
- [ ] Invalidation event publication failures are logged and alerted — a failed publish does not silently leave stale security-relevant data in cache
