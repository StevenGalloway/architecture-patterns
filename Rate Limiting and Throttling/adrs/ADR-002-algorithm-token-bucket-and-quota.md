# ADR-002: Use token bucket for bursts and quotas for fairness

## Status
Accepted

## Date
2026-01-11

## Context
Clients may legitimately burst (mobile reconnects, page refreshes), but long-term fairness is still required.

## Decision
- **Token bucket** per IP for burst-friendly request shaping
- **Quota** per API key (e.g., daily) to enforce fairness across tenants/plans

## Consequences
- better UX under normal bursty behavior
- requires tuning burst size, refill rate, and quota windows
