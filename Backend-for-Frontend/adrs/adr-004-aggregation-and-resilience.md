# ADR-004: BFF provides partial responses with strict timeouts

## Status
Accepted

## Context
Mobile UX and home-page endpoints should not fully fail when a single downstream dependency is slow or degraded.

## Decision
BFF will:
- Use strict per-upstream timeouts (e.g., 200–500ms budget)
- Return partial responses when possible (e.g., recs=[] if recs service fails)
- Emit metrics for partial response rate and upstream timeout rate

## Consequences
- Better perceived availability and UX
- Requires UI to handle missing sections gracefully
