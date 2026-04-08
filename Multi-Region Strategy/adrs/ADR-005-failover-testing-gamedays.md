# ADR-005: Run quarterly multi-region failover game days

## Status
Accepted

## Date
2026-01-11

## Context
Failover that is untested is effectively broken. Operators need muscle memory.

## Decision
Conduct recurring game days:
- simulate Region A outage (health check fail)
- validate DNS/traffic shift + service stability
- validate data correctness and user-impact boundaries
- capture learnings and update runbooks

## Consequences
- improved reliability and confidence
- consumes operational time; must be scheduled and owned
