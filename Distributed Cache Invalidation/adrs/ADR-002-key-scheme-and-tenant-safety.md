# ADR-002: Standardize cache key scheme with tenant safety

## Status
Accepted

## Date
2025-08-06

## Context
When the Product API was first deployed for a multi-tenant SaaS product, each tenant saw a separate product catalog: some products were available only to enterprise tenants, some had tenant-specific pricing overrides, and some had tenant-specific metadata fields. The cache was initially keyed only by entity type and entity ID (`product:12345`), without encoding the tenant.

Two problems emerged from this key scheme in the same week:

**Cross-tenant data exposure:** An enterprise tenant with a custom pricing override queried product 12345. The cache was empty for that key (it was a cache miss), so the response was fetched from the database, which returned the enterprise-tier price. This result was stored in the cache under key `product:12345`. A standard-tier tenant then queried product 12345. The cache returned the enterprise-tier price (a cache hit). The standard-tier customer was shown a lower price than they were entitled to because the cache key did not distinguish between tenants.

**Deploy-time schema corruption:** A schema change in the product response (adding a `catalog_category` field as a required object) was deployed while old cache entries were still valid. Some requests returned responses deserialized from old cache entries (missing the new field), and some returned responses from fresh origin fetches (with the field). Different API responses for the same product on the same day confused client-side code that expected the field to always be present.

Both problems would have been prevented by a key scheme that encoded tenant ID and schema version.

## Decision
All cache keys follow the standard format: `{env}:{tenant_id}:{schema_version}:{entity_type}:{entity_id}[:{suffix}]`

**Field semantics:**
- `env`: `prod`, `staging`, `dev`. Prevents staging invalidation events from affecting the production cache if they share a NATS subject prefix
- `tenant_id`: Required for all tenant-scoped entities. Global entities (cross-tenant reference data) use `global`
- `schema_version`: Integer, incremented when the cached response structure changes in a backward-incompatible way. Old-version keys are left to expire naturally; the new version starts fresh
- `entity_type`: Lowercase snake_case entity name
- `entity_id`: Stable identifier. Must not contain PII (no email, no user-facing names)
- `suffix`: Optional secondary discriminator (e.g., warehouse ID for inventory, locale for translated product content)

**Examples:**
- `prod:tenant-acme:v3:product:12345` -- ACME tenant's product 12345 under schema version 3
- `prod:global:v1:category:electronics` -- Global (cross-tenant) category entity
- `staging:tenant-demo:v3:product:12345:locale-fr` -- French locale product response in staging

**Invalidation event key matching:** Invalidation events contain exact keys to evict, not patterns. Wildcard invalidation (e.g., evict all keys for a tenant) is a separate operation supported by a Redis SCAN with the tenant prefix, not by pub/sub events.

## Alternatives Considered

**Separate Redis keyspace per tenant:** Provision a separate Redis database (SELECT N) or separate Redis instance per tenant. True isolation with no key collision risk. Rejected because Redis database separation (SELECT N) is not supported in Redis Cluster mode, and separate Redis instances per tenant add infrastructure cost that scales with tenant count, which is unacceptable for a product with hundreds of tenants.

**Key hashing with metadata stored separately:** Hash the full cache key parameters to produce a short opaque key, and store the key composition metadata in a separate index. Shorter keys reduce memory usage. Rejected because opaque keys cannot be targeted by invalidation events (the invalidation event must contain the full key to evict, not a hash). Opaque keys also make debugging cache contents impossible without consulting the index.

**Version suffix instead of version prefix:** Place the schema version at the end of the key (`prod:tenant-acme:product:12345:v3`). Functionally equivalent. Rejected because version-as-prefix makes wildcard invalidation of all entries for a specific version (`prod:*:v2:*`) structurally explicit in the key format, which is useful during schema migrations.

## Consequences

### Positive
- Cross-tenant cache data exposure is eliminated: `prod:tenant-acme:v3:product:12345` and `prod:tenant-xyz:v3:product:12345` are distinct keys with no possibility of one being served to the other tenant's request
- Schema version in the key eliminates the deploy-time schema corruption pattern: old schema version keys expire naturally while new schema version keys are populated by fresh fetches
- The key format is human-readable during debugging: inspecting a Redis key reveals the environment, tenant, schema version, entity type, and entity ID without consulting a separate index

### Negative
- Key length increases with each segment; for high-cardinality entities (millions of products × hundreds of tenants), the additional memory for key storage is non-trivial
- Schema version must be incremented whenever the response structure changes in a backward-incompatible way; forgetting to increment the version is a correctness bug that is not caught by automated tests unless the tests explicitly check for version consistency

### Risks
- **PII in key names.** A developer using an email address or customer name as the entity_id segment creates a privacy problem (PII appears in Redis keyspace logs, NATS event payloads, and log files). Mitigation: the code review checklist for any cache key construction includes a check that no PII appears in the entity_id segment.

## Review Trigger
Revisit if the product's tenancy model changes (e.g., moving from per-tenant isolation to per-user isolation for some entity types), which would require adding a `user_id` segment to the key format for user-specific cached data.
