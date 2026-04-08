# ADR-004: Define per-region SLOs and global user-experience SLOs

## Status
Accepted

## Date
2026-01-11

## Context
Multi-region failures can be subtle: partial outages, elevated latency, regional dependency issues.

## Decision
Instrument and alert on:
- per-region availability + p95/p99 latency
- global success rate and synthetic probes per region
- replication lag / stream lag (where applicable)
- traffic distribution (unexpected skew)

## Consequences
- faster detection of regional degradations
- requires dashboards, alert hygiene, and an on-call playbook
