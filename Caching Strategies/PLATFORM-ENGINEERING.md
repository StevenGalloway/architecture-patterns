# Platform Engineering — Caching Strategies

## Caching as a Platform Primitive

Teams should not need to write Redis connection management, key serialization logic, TTL policy decisions, stampede protection, or eviction tuning. These are solved problems. The platform provides them as a shared library and managed service, and stream-aligned teams consume caching the same way they consume logging or tracing — as infrastructure they use, not infrastructure they build.

Done well, caching is invisible to service teams: they annotate a method or declare a cache config, and the platform handles the rest. Done poorly, every team has their own Redis client, their own key schema, and their own on-call rotation for a problem they all have in common. The inconsistency cost is paid continuously — in engineering hours, in incident duration, and in "mystery stale" bugs that no one team can fully diagnose.

---

## The Paved Road Model

| Without platform caching (dirt road) | With platform caching (paved road) |
|---|---|
| Each team installs their own Redis client library, configures connection pools, writes retry logic | Shared cache client library handles connection lifecycle, retry, and circuit breaking |
| Each team invents their own key namespace (`order:123`, `ORDER_123`, `ord-123` all exist simultaneously) | Enforced key namespace schema: `{tenant_id}:{service}:{entity_type}:{entity_id}` |
| Each team sets TTLs based on intuition or cargo-culting (everyone uses 300 seconds) | Platform-defined TTL tiers: `hot` (30s), `warm` (5m), `cool` (60m), `cold` (24h) — teams select a tier, not a number |
| Each team discovers stampede bugs in production when traffic spikes | Stampede protection (distributed lock + single-writer policy) built into the client library and on by default |
| Cache miss on a hot key causes 50 concurrent database calls — nobody knows why | Cache miss rate, stampede events, and thundering herds are instrumented and alerted automatically |
| Debugging a cache issue requires Redis CLI access and knowing the right key format | Platform provides a debug CLI (`cache-cli get --service orders --entity order --id 8a91f3b2`) that uses the enforced schema |
| PII accidentally cached in plaintext because the engineer didn't know the policy | PII fields declared in config are automatically encrypted by the client library before writing; decrypted on read |

The platform team's job is to make the paved road the path of least resistance. If it is easier to write your own Redis client than to use the platform library, teams will — and the platform loses its primary value.

---

## Self-Service Model

Teams declare cache requirements via configuration rather than writing infrastructure code. The platform provisions and manages what they declared.

### Cache Namespace Declaration

Each service team maintains a cache configuration file:

```yaml
# services/orders/cache.yaml
cache:
  namespace: orders
  ttl_tier: warm               # hot=30s, warm=5m, cool=60m, cold=24h
  eviction_policy: allkeys-lru
  memory_quota_mb: 2048        # platform enforces this via Redis namespace quota
  pii_fields:                  # encrypted before write, decrypted on read
    - customer.email
    - customer.phone
    - shipping_address.line1
  data_classification: internal # internal | pii | phi | pci (pci disables this namespace entirely)
  invalidation_events:
    - topic: orders.updated
      key_pattern: "{tenant_id}:orders:order:{event.order_id}"
    - topic: customers.deleted
      key_pattern: "{tenant_id}:orders:customer:{event.customer_id}:*"
```

The platform CI pipeline validates this config against the schema, checks that `memory_quota_mb` does not exceed the team's allocated tier, verifies that `data_classification: pci` results in a build failure (PANs must not be cached), and provisions the Redis namespace with the declared settings.

**What teams control:** key namespace, TTL tier selection, PII field declarations, memory quota (within their allocation), invalidation event subscriptions.

**What teams do not control:** the actual TTL values within tiers (platform-defined), eviction policy defaults, connection pooling, TLS configuration, AUTH credentials, cross-namespace access.

---

## Platform Contract

### What the platform provides

| Capability | SLA |
|---|---|
| Redis cluster availability | 99.9% monthly uptime; automated failover within 30 seconds |
| P99 cache GET latency | < 1ms within the same availability zone |
| P99 cache SET latency | < 2ms |
| Memory quota enforcement | Namespace eviction prevents any team from exceeding declared quota |
| Stampede protection | Distributed lock prevents concurrent cache population for the same key |
| Automatic eviction | Platform manages `maxmemory-policy` per namespace tier |
| Secret rotation | Redis AUTH credentials rotate without service restart or deployment |
| Breaking change notice | 30-day minimum notice for any breaking change to cache config schema |

### What service teams are responsible for

| Responsibility | Owner |
|---|---|
| Key design within their namespace | Stream-aligned team |
| TTL tier selection appropriate to data freshness requirements | Stream-aligned team |
| Declaring which fields are PII | Stream-aligned team (audited by Security) |
| Not caching data at a higher classification than their declared tier allows | Stream-aligned team |
| Documenting their invalidation event contracts | Stream-aligned team |
| Runbook for "service's cache hit rate dropped" | Stream-aligned team |

---

## Developer Experience

A caching platform that is hard to develop against creates shadow IT: teams build their own Redis clients, use environment variables for connection strings, and bypass the platform entirely. The developer experience must be first-class.

### Local Development

Teams need caching to work locally without accessing a shared Redis cluster:

```bash
# Start local development environment with Redis
docker compose up redis

# Platform cache client library auto-detects REDIS_URL=redis://localhost:6379
# in non-production environments and connects to local Redis
# No TLS, no AUTH required in local mode

# Inspect local cache state using the platform debug CLI
cache-cli get --service orders --entity order --id 8a91f3b2
# Output: { hit: true, ttl_remaining: 247s, value: { order_id: "8a91f3b2", ... } }

cache-cli stats --namespace orders
# Output: { hit_rate: 0.73, memory_used_mb: 42, eviction_count: 0, key_count: 8241 }
```

The `docker-compose.yml` in the platform's developer bootstrap includes a Redis (or Valkey) container configured to match production behavior. Teams should never need to know the Redis connection string — the platform library handles environment-specific connection configuration.

### Testing Support

The platform provides a test helper for asserting cache behavior without a real Redis:

```python
from platform_cache.testing import CacheTestContext

def test_order_is_cached_after_first_read(cache_test_context):
    with CacheTestContext(namespace="orders") as cache:
        # First call: cache miss, hits database
        result_1 = get_order("ord_8a91f3b2")
        assert cache.miss_count == 1
        assert cache.db_call_count == 1

        # Second call: cache hit, no database
        result_2 = get_order("ord_8a91f3b2")
        assert cache.hit_count == 1
        assert cache.db_call_count == 1  # unchanged

        # Verify key structure
        assert cache.has_key("{tenant_id}:orders:order:ord_8a91f3b2")
        assert cache.get_ttl("{tenant_id}:orders:order:ord_8a91f3b2") <= 300
```

This test helper uses an in-process fake cache (not a real Redis connection) so tests are fast, hermetic, and runnable without Docker. It records hit/miss decisions, key names, and TTLs so teams can assert cache behavior as rigorously as business logic.

---

## Anti-Patterns That Signal Caching Has Become a Platform Problem

Watch for these signals:

| Signal | What it means | Platform response |
|---|---|---|
| Teams implement their own Redis clients and bypass the platform library | The platform library is too hard to use, undocumented, or missing a capability teams need | Fix the library or extend the contract; don't accept bypass as a valid solution |
| Multiple services use the same key namespace (e.g., both `orders` service and `fulfillment` service write to `orders:order:{id}`) | No namespace governance; cache is now a shared mutable state with no single owner | Enforce namespace ownership in CI; each namespace has exactly one owning service |
| Cache-related incidents take more than 30 minutes to diagnose | No platform runbook, no platform observability, incident response requires Redis CLI expertise | Platform must provide a runbook and a diagnostic CLI before cache goes to production |
| Different teams use different TTL values for the same data entity (product catalog cached for 1 minute by Product service, 60 minutes by Search service) | No coordinated TTL policy for shared data; stale reads are a function of which service cached last | TTL policy must be associated with the data's owning service, not with the consuming service |
| New service onboarding requires a platform team ticket to get a Redis namespace | Self-service is not working; platform team is a bottleneck | Automate namespace provisioning from `cache.yaml` declaration; no human in the loop |
| Hit rate for a new service is 15% three days after launch | Cache is not warmed, TTL is too short, or key design is wrong (too specific) | Platform provides hit rate dashboards from day one; low hit rate triggers a platform health check, not a mystery |
