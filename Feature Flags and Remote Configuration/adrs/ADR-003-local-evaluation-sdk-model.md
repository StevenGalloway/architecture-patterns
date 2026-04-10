# ADR-003: Use in-process SDK with local cache and SSE streaming for flag delivery

## Status
Accepted

## Date
2026-02-05

## Context
The flag evaluation model determines how services retrieve flag state at request time. Two approaches were evaluated during a proof of concept:

**Remote evaluation (API call per request):** Each flag check makes an HTTP call to the management API. The management API evaluates the targeting rules server-side and returns the variant. Straightforward to implement; flag evaluation logic lives in one place.

During the proof of concept, a load test simulated 2,000 requests/second across 8 service instances, each evaluating 3–5 flags per request. The management API received approximately 8,000–10,000 evaluation requests per second. At this scale, the management API required horizontal scaling proportional to total platform traffic — it effectively became a core infrastructure component in the request path of every service. Latency at p99 was 18ms per evaluation call, adding 50–80ms to request latency for services that evaluated flags on multiple data paths.

More critically: during a 30-second management API downtime in the POC, all 8 service instances began returning errors because they could not evaluate flags. A flag evaluation failure caused all flagged code paths to fail rather than falling back gracefully.

**Local evaluation (in-process cache):** SDK seeds a local in-process cache at startup and evaluates rules locally on each request — no network call. The management API pushes flag updates to connected SDK instances via SSE. Evaluation latency is sub-millisecond. During management API downtime, services continue using their last-known-good cache.

## Decision
Use an in-process SDK that:
1. Seeds a local in-process cache from the management API at startup (`GET /flags`)
2. Evaluates all targeting rules locally against the user context — no network call per evaluation
3. Maintains a persistent SSE connection to the management API; receives flag updates within 5 seconds of a change (sync lag SLO)
4. Uses last-known-good cache during management API outages
5. Falls back to the flag's `safeDefault` value if the flag key is not present in cache

The SDK is a TypeScript library (`@internal/flag-sdk`) published to the internal npm registry. Each service imports and initializes the SDK in its application bootstrap code.

**Sync lag SLO:** Flag changes must reach all connected SDK instances within 5 seconds. If an SSE connection drops, the SDK reconnects with exponential backoff (1s, 2s, 4s, max 30s) and re-seeds its cache from the management API on reconnect to close any gap.

## Alternatives Considered

**Remote evaluation model (rejected):** Described in Context above. Rejected because: (1) 18ms p99 evaluation latency is unacceptable for flags evaluated on hot request paths; (2) management API must scale proportionally with total platform request volume, making it a mandatory high-scale component; (3) management API outage directly causes service degradation rather than graceful fallback.

**Polling model (SDK polls management API every N seconds):** SDK polls `GET /flags` every 5 seconds. Simpler than SSE — no persistent connection management. Rejected because: (1) 5-second polling means kill switch response time is up to 5 seconds plus the HTTP round trip; (2) 8 service instances × 3 pods each = 24 concurrent polling connections at 5-second intervals against the management API, creating predictable bursts; (3) SSE achieves the same freshness SLO with push semantics and lower polling overhead.

**Shared Redis cache (all SDK instances read directly from Redis):** Skip the management API entirely; SDK instances read flag state directly from Redis using a well-known key schema. Updates write directly to Redis; SDK instances watch for keyspace notifications. Rejected because: (1) keyspace notifications in Redis require explicit configuration and are disabled by default; (2) SDK instances would need direct Redis access, coupling all services to the flag system's storage layer; (3) the management API's audit log and validation logic are bypassed if writes go directly to Redis.

## Consequences

### Positive
- Sub-millisecond flag evaluation (local hash map lookup + rule evaluation in-process)
- Resilient to management API outages — services continue with last-known-good state for all flags
- No per-request network overhead; management API does not need to scale with request volume
- Kill switch response time bounded by SSE sync lag SLO (< 5 seconds vs. 9-minute redeployment)

### Negative
- Brief inconsistency window (up to 5s) during flag updates — different service instances may evaluate the same flag differently during the sync window
- Memory overhead proportional to number of flags (at 200 flags with moderate payload sizes, estimated < 5MB per instance — acceptable)
- SDK must be versioned and updated when the flag schema or evaluation semantics change; all services must update their SDK dependency
- Initial startup requires a reachable management API to seed the cache; cold starts during a management API outage will use `safeDefault` values for all flags

### Risks
- **SSE connection leak under high reconnect rates.** If many service instances reconnect simultaneously (e.g., after a management API restart), the server must handle a large number of concurrent SSE upgrade requests. Mitigation: SSE reconnect backoff with jitter; management API load tested for connection fan-out at deploy scale.
- **Safe defaults that are not actually safe.** If a flag's `safeDefault` is set incorrectly (e.g., `safeDefault: true` for a kill switch that should default to disabled), management API downtime will activate the feature for all users. Mitigation: the flag creation process requires explicit `safeDefault` documentation and peer review for all Ops/Kill Switch flags.

## Review Trigger
Revisit if the number of flags grows past 1,000 or if average flag payload size increases significantly — at that scale, in-process cache memory and seed time at startup may become material. Revisit the SSE model if the platform moves to a serverless architecture where persistent connections are not supported.
