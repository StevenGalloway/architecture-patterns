# ADR-001: Adopt feature flags and remote configuration for progressive delivery

## Status
Accepted

## Date
2026-01-14

## Context
Engineering teams practice trunk-based development and deploy multiple times per day. Incomplete features must ship to production without being visible to users. The alternative — long-lived feature branches — was causing 3–5 day merge conflict resolution sessions whenever two teams worked on the same service simultaneously.

Rollback via redeployment takes 5–10 minutes minimum. During a production incident on 2025-11-22, a bad configuration change caused error rates to spike to 8%. The on-call engineer identified the cause within 4 minutes but the fix (reverting the deploy) took another 9 minutes, during which the error rate remained elevated. A flag-based disable would have resolved the issue in under 30 seconds.

Product teams also needed to run A/B experiments on checkout flow variants. The existing process required separate code deploys per variant, meaning experiments took 2–3 days to set up and were rarely cleaned up afterward. By the time the experiment concluded, the experiment code had become permanent because nobody wanted to risk removing it.

## Decision
Adopt a feature flag system with:
- A centralized flag management API (Express + Redis) as the control plane
- An in-process SDK per service with local evaluation cache and SSE-based sync
- A four-type flag taxonomy with enforced TTLs and ownership
- Remote configuration as a typed extension of the same system

The system is built in-house rather than adopting a SaaS provider (LaunchDarkly, Flagsmith) due to data residency requirements and the team's preference for owning the flag storage layer. The architecture mirrors the local-evaluation model used by open-source tools like flagd and Flipt.

## Alternatives Considered

**SaaS feature flag provider (LaunchDarkly, Flagsmith):** Fully managed, production-hardened, faster to adopt. Rejected because sensitive user context data (tenant IDs, plan tiers) would be sent to a third-party service for evaluation, conflicting with data residency requirements. Also: SaaS provider becomes an availability dependency; their outage affects feature evaluation in all services.

**Git-based feature flags (feature flags as config files in the repo):** Flag values stored in YAML files and deployed with the service. Simple, auditable via git history, no external dependency. Rejected because updating a flag requires a code deploy — this defeats the primary purpose of flag-based rollback. Response time for a kill switch would be the same as a redeployment.

**Application config files in a secrets manager (AWS Parameter Store, Vault):** Runtime-readable config without a deploy. Works well for static configuration. Rejected as the sole mechanism because it has no targeting rule evaluation (cannot do percentage rollouts or per-tenant overrides), no SDK for local evaluation caching, and no purpose-built audit log or staleness management.

## Consequences

### Positive
- Zero-downtime rollback via flag disable (no redeployment required); estimated 30-second kill switch response vs. 9-minute redeployment
- Progressive delivery with health-gated rollout stages; incomplete features can ship to production safely on trunk
- On-call kill switches operable without production deploy access; on-call rotation can act immediately
- A/B testing without separate feature branches or deploys; experiment setup time drops from 2–3 days to under 1 hour

### Negative
- Flag lifecycle governance is required; without it, flag debt accumulates — the same problem the previous A/B experiment process created
- Testing complexity increases: each flag adds a code path variant that should be tested in both states
- SDK adds a dependency to every service; SDK bugs affect all flag evaluations across the platform
- Management API becomes a soft dependency for new service deployments (SDK needs to seed its cache on startup)

### Risks
- **Management API is a new platform component.** It must be operated reliably. If the management API is unavailable at deploy time, new service instances cannot seed their SDK cache. Mitigation: SDK must handle startup gracefully with a default state (all flags at their `safeDefault` value) when the management API is unreachable. Management API SLO: 99.9%.
- **Flag proliferation without enforcement.** If the taxonomy and TTL rules are not enforced by tooling, teams will treat all flags as permanent and the codebase accumulates permanent conditional branches. Mitigation: CI lint check on flag schema; automated staleness alerts; quarterly cleanup sprints.

## Review Trigger
Revisit the self-hosted model if the management API's operational burden exceeds the equivalent SaaS subscription cost. Revisit SDK architecture if new languages are onboarded that require separate SDK implementations — at 3+ languages, a SaaS provider's multi-language SDK support may justify the vendor dependency.
