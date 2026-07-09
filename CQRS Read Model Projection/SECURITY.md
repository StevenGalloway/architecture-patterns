# Security Architecture — CQRS Read Model Projection

## Threat Model

CQRS with read model projections changes the system's attack surface in ways that a single-database architecture does not expose. The projector is a high-privilege service that reads from the write store, consumes from the event bus, and writes to multiple read model stores. The event bus is a shared communication channel between the command side and all consumers. Each of these boundaries is a new threat surface.

The architecture's most important security property is also its key risk: **a single event emitted by the command side propagates to all read models through the projector**. A poisoned event, a misconfigured projector, or a compromised event bus credential does not affect one read model — it affects all of them simultaneously.

### Attack Surface

```
Command Side → Event Bus → Projector → Read Model Stores → Query Services → Consumers
     ↑               ↑           ↑              ↑                 ↑
 (write auth)  (bus access)  (high priv)  (per-store auth)  (consumer auth)
```

| Attack Surface | Threat | Severity |
|---|---|---|
| Event stream poisoning | Attacker injects malicious or malformed events into the event bus; projector faithfully projects them into all read models | Critical |
| Read model staleness exploitation | Attacker submits a transaction and immediately queries the read model before projection completes — used for double-spend or inventory fraud | Critical |
| Projector credential compromise | Projector service has read access to write store and write access to all read model stores; compromise gives full read model corruption capability | Critical |
| Replay as exfiltration vector | Replay functionality reads the full historical event stream; unauthorized replay reconstructs all historical business state | High |
| Unauthorized analytics read model access | Analytics store is intentionally denormalized and aggregated — it may reveal sensitive business metrics to principals who should not see them | High |
| Read model cache poisoning | Downstream services cache read model responses; a projection bug serves corrupted data until cache TTL expires | High |
| Event schema injection via schema registry | Attacker pushes a malicious schema version that causes the projector to misinterpret event payloads | High |
| Dead-letter queue as intelligence source | DLQ contains failed events with full payloads; unauthorized DLQ read access exposes business event history | Medium |
| Consumer lag monitoring data | Lag metrics expose projector processing patterns; can be used to time attacks during high-lag windows when stale data is most likely | Low |

---

## Event Stream Integrity

### Event Signing

The command side signs all events before publishing. The projector verifies the signature before processing. An event that fails signature verification is routed to a separate failed-signature queue, not the DLQ (which handles transient processing failures).

```
Command side:
  event = buildEvent(orderCreated)
  signature = HMAC-SHA256(event.payload, signingKey)
  event.metadata.signature = signature
  event.metadata.signing_key_id = currentKeyId
  publish(event)

Projector:
  event = consume()
  signingKey = keyStore.get(event.metadata.signing_key_id)
  if not HMAC-SHA256-verify(event.payload, signingKey, event.metadata.signature):
    route_to_signature_failure_queue(event)
    alert("Event signature verification failed")
    return  # Do not process
```

Signing key management: rotate signing keys on a defined schedule (quarterly) and on any personnel change with key access. Keys are stored in AWS Secrets Manager or HashiCorp Vault, never in environment variables or config files. The projector fetches the key on startup and caches it with a TTL; on signature failure with a known key ID, re-fetch once to handle rotation lag.

### Event Source Authentication

The event bus must authenticate publishers. Only the command-side service may publish to the orders event topic.

| Event bus | Authentication mechanism |
|---|---|
| Kafka | mTLS + ACL: only the command service's client certificate may produce to `orders.events` topic |
| Confluent Cloud | API key scoped to produce-only on specific topics; separate key for consumer |
| AWS SNS | IAM policy: only the command service's IAM role may publish to the orders SNS topic |
| AWS EventBridge | IAM resource policy restricting PutEvents to specific source principals |

Audit: log every publish attempt with the principal identity. Alert on publish from any principal that is not the expected command service.

---

## Projector Privilege Controls

The projector is the highest-privilege service in the CQRS architecture. It must have:
- Read access to the write-side event tables or write-side database (for projector initialization and catch-up)
- Consume access on the event bus topic
- Write access to all read model stores

This privilege concentration is a target. Controls:

**Separate credentials per store:** The projector does not use a single "superuser" credential for all stores. It holds separate, least-privilege credentials for each read model store.

| Access | Credential | Permissions |
|---|---|---|
| Event bus (Kafka/SNS) | `projector-consumer-key` | Consume/read only, specific topic |
| Customer history DB | `projector-history-writer` | INSERT, UPDATE on `order_history` schema only; no DELETE, no SELECT on write schema |
| Fulfillment cache (Redis) | `projector-fulfillment-writer` | SET, HSET, EXPIRE on `fulfillment:*` key namespace only |
| Analytics store (Redshift) | `projector-analytics-writer` | INSERT, UPDATE on analytics schema; no DDL |
| Idempotency store | `projector-idempotency` | GET, SET on idempotency key namespace; TTL enforced |

**Network isolation:** The projector runs in a private subnet. It cannot receive inbound connections — it only initiates outbound connections to the event bus and read model stores. Inbound access is restricted to the observability platform (metrics scrape) and the replay controller (control plane API).

**Runtime hardening:**
- Read-only filesystem except for log output
- No shell access in production container
- Secrets injected via secrets manager at runtime, not baked into container image
- Container image scanned for CVEs in CI pipeline

---

## Read Model Staleness Exploitation

CQRS reads are eventually consistent. This creates a fraud window: an attacker who knows the projection lag can submit a transaction and query the read model within the lag window to see a pre-transaction state.

**Example attack:** An attacker places an order that should exhaust their credit limit. Within the 1-2 second projection lag, they place a second order. The read model used for the credit check still shows the pre-first-order balance. Both orders succeed.

**Mitigations:**

1. **Write-side consistency for high-stakes reads:** For operations where stale data creates fraud risk (inventory reservation, credit checks, balance queries), read from the write-side database directly. These are a small subset of all reads. The majority of reads (order history display, dashboard counts, analytics) do not carry this risk. Document which operations require write-side consistency (see ADR-005).

2. **Optimistic locking on the write side:** For inventory and credit operations, enforce the constraint on the write side with optimistic locking. The read model is used for display; the write side enforces the invariant. Do not trust read model data for constraint enforcement in financial or inventory flows.

3. **Lag-aware client responses:** API responses that return eventually consistent data include a `data-freshness` header with the last-updated timestamp of the read model. Clients that require consistency can detect and reject stale responses. Internal fraud systems consume this header.

---

## Analytics Read Model Access Controls

The analytics read model in the column store is deliberately denormalized and aggregated. It may contain:
- Revenue figures by merchant, product, and time period
- Order volume trends that reveal business performance
- Customer behavioral aggregates

This data is more sensitive than the normalized write-side schema, not less, despite containing no individual customer PII. It reveals business intelligence that competitors or former employees should not access.

**Access controls:**

| Consumer | Access scope | Authentication |
|---|---|---|
| BI analysts | Analytics schema, read-only | SSO via federated identity; MFA required |
| Data science team | Analytics schema + training export, read-only | Service account with IAM role; short-lived credentials |
| Fulfillment operations | Fulfillment Redis cache only; no analytics access | Service account with Redis ACL |
| Customer support | Customer history DB only; no analytics or fulfillment Redis | Service account with row-level security by customer ID |
| External partners | No direct read model access; via query API with pagination limits | OAuth 2.0 scoped tokens |

The analytics read model must not be reachable from the same network path as the customer history read model. Use separate VPC endpoints or separate RDS security groups. Analysts who can access aggregated business metrics should not automatically have access to customer-level order history.

---

## Replay Security

Replay is a high-privilege operation. Executing a replay reads the full historical event stream — potentially years of order history — and writes it into the target read model store. An unauthorized or incorrectly targeted replay can:

- Overwrite a live read model with historical data (rolling back weeks of projections)
- Expose the full event history to the replay operator's credential
- Trigger write storms on the read model store that cause availability degradation

**Controls:**

1. **Replay requires explicit authorization:** Replay is a two-step operation. A privileged principal (SRE or platform team) submits a replay request. A second principal approves it. No single person can initiate a production replay unilaterally. Log both events.

2. **Replay runs against a shadow target by default:** The replay controller writes to a separate (shadow) read model schema. A second step — also requiring approval — cuts over the query service to the new schema. This prevents a bad replay from corrupting the live read model.

3. **Audit log:** Every replay operation is logged with: initiating principal, approving principal, target read model, event range replayed, start time, completion time, and event count processed.

4. **Scope limiting:** Replay operations are scoped to a specific event type range and time window. Full-history replays are a separate, more restricted operation.

---

## GDPR: Right to Erasure in an Immutable Event Stream

GDPR Article 17 requires the ability to erase personal data on request. CQRS presents a structural challenge: the event stream is immutable, and events may contain customer PII (name, address, email in `OrderCreated` events).

**Strategy:**

1. **Crypto-shredding:** Each customer's PII in the event stream is encrypted with a per-customer key stored in a key management service. On erasure request: delete the customer's encryption key. All historical events containing that customer's PII become unreadable without adding an erasure event to the stream.

2. **Read model erasure is immediate:** Rebuild all read models for that customer ID. Customer history read model: delete rows. Fulfillment Redis cache: delete keys. Analytics: analytics data is aggregated and does not contain individual customer identifiers — verify before assuming this.

3. **Event stream tombstone:** After crypto-shredding, publish a `CustomerDataErased` event. All downstream projectors handle this event by deleting or anonymizing that customer's records. This event is itself retained (it contains only the customer ID and erasure timestamp, not PII) to enable auditability.

4. **Do not store PII in event metadata fields** (topic keys, partition keys, header values). These are typically not encrypted with the payload encryption key.

---

## Compliance

| Standard | CQRS-specific consideration |
|---|---|
| **SOC 2 CC6.1** | Separate access credentials per read model store. Audit log of all projector writes and replay operations. Read model access controls by consumer type. |
| **SOC 2 CC6.3** | Event stream access controls: only the command service may publish; only the projector may consume. IAM/ACL audit quarterly. |
| **SOC 2 CC7.2** | Projector lag monitoring satisfies "detect anomalies in data processing" requirement. DLQ depth is a data integrity signal. |
| **PCI DSS Req 3** | Cardholder data in events must be encrypted at rest and in transit. Column-store analytics must not contain full card numbers. |
| **GDPR Art. 17** | Crypto-shredding strategy required. Read model erasure process documented and tested. |
| **GDPR Art. 30** | Event stream and all read model stores are processing records. Retention periods must be documented for each. |

---

## Security Review Checklist

Before any projector change reaches production:

- [ ] Event signing verification is enabled; events failing signature check are rejected, not processed
- [ ] Separate credentials in use for each read model store; no shared superuser credential
- [ ] Projector runs with read-only filesystem; no shell access
- [ ] Replay requires two-principal authorization and is logged
- [ ] Analytics read model is not reachable from the customer history read model network path
- [ ] DLQ is access-controlled; not readable by consumer-facing service accounts
- [ ] High-stakes operations (credit check, inventory reservation) read from write side, not read models
- [ ] GDPR crypto-shredding key management is tested (verify erasure renders event payload unreadable)
- [ ] Container image CVE scan passes in CI pipeline
- [ ] Secrets are injected via secrets manager; no secrets in environment variable definitions or config files
