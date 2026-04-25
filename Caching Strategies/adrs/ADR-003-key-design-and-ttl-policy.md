# ADR-003: Standardize key design and TTL policy (with jitter)

## Status
Accepted

## Date
2025-09-03

## Context
As caching expanded from one service (Product Catalog) to three (Catalog, User Profile, Inventory), two problems emerged from inconsistent key naming conventions.

The first was a cross-tenant data leak in a staging environment. The Inventory service cached a response under the key `inventory:product:12345`, without including the tenant identifier. In our multi-tenant setup, different tenants have different inventory visibility rules (some products are exclusive to enterprise accounts). A request from a standard-tier tenant triggered a cache miss, populated the cache with standard-tier inventory data, and the subsequent enterprise-tier tenant request received the standard-tier response from cache rather than querying the origin.

The second problem was during a service deployment: a code change that modified the Inventory service's response structure (renaming `available_units` to `quantity_available`) was deployed while old keys were still cached. For approximately 45 minutes, some requests received responses deserialized from the old key format (which the new code tried to read using the new field names) and produced null fields in the client output.

Both problems would have been prevented by a structured key naming convention and a version component in the key.

## Decision
All cache keys follow the format: `{env}:{tenant_id}:{schema_version}:{entity_type}:{entity_id}[:{suffix}]`

Examples:
- `prod:tenant-abc:v2:product:12345`
- `prod:tenant-xyz:v2:inventory:12345:warehouse-east`
- `staging:tenant-abc:v1:user_profile:user-789`

**Field rules:**
- `env`: Required. Prevents staging cache from colliding with production cache if they share a Redis cluster
- `tenant_id`: Required for any entity with tenant-specific visibility rules. Global entities (non-tenant-specific reference data) use `global` as the tenant segment
- `schema_version`: Required. Incremented whenever the cached response structure changes. Old version keys are allowed to expire naturally; no active cleanup needed
- `entity_type`: Snake_case name of the entity type
- `entity_id`: The unique identifier. Do not use PII (email addresses, names) as identifier segments

**TTL policy with jitter:**
- Product data (catalog): fresh 60s, stale 120s, ±10s jitter applied at write time
- Inventory data: fresh 30s, stale 60s (correctness-sensitive, shorter TTL)
- User profile data: fresh 300s, stale 600s (changes infrequently)
- Jitter: ±15% of the base TTL, applied as a random offset at cache write time

Jitter prevents synchronized expiry of keys that were populated at the same time (e.g., after a cache warm-up following a deployment).

## Alternatives Considered

**Opaque hash keys generated from query parameters:** Hash the full request parameters (tenant, entity, filters) to produce a short, opaque cache key. Simpler to generate but rejected because opaque keys cannot be inspected during debugging, cannot be targeted for partial invalidation (e.g., invalidate all keys for tenant-abc), and do not encode the schema version needed to avoid stale deserialization bugs.

**TTL based on data category only (no jitter):** Set a fixed TTL for each data category without per-write jitter. Simpler to configure but rejected because it causes synchronized expiry for data populated at the same time -- exactly the stampede pattern that ADR-002 addresses. Jitter is inexpensive to implement and prevents a predictable failure pattern.

**Global key namespace (no environment or tenant prefix):** Use minimal keys like `product:12345` without environment or tenant segments, and rely on Redis database separation or separate Redis instances per environment. Rejected because Redis database separation (SELECT N) is not supported in Redis Cluster mode, and separate Redis instances per environment add infrastructure cost and management overhead that is not justified given the low cost of prefixed keys.

## Consequences

### Positive
- The cross-tenant data leak pattern is prevented by requiring the tenant_id segment for all tenant-specific entities
- Schema version in the key means code deployments that change response structure do not cause deserialization errors; old keys expire naturally at their TTL
- Structured keys support targeted invalidation patterns (wildcard scan for `*:tenant-abc:*` to invalidate all keys for a specific tenant during offboarding)

### Negative
- Key length increases with each additional prefix segment, consuming slightly more Redis memory per key; for 10 million cached entries this is an additional ~200MB in key storage overhead
- The schema_version segment requires a conscious increment on every cached schema change, which is easy to forget if it is not part of the deployment checklist

### Risks
- **PII in key names.** If a developer adds an email address or user name to a key (e.g., for user-specific caching), it appears in Redis keyspace scans and potentially in log files. Mitigation: the key convention document explicitly prohibits PII in any key segment and is referenced in the code review checklist for caching changes.

## Review Trigger
Revisit the schema_version approach if the team adopts a serialization format with embedded schema evolution (e.g., Protocol Buffers with backward-compatible field additions), which would reduce the need to increment the schema version on every response structure change.
