# ADR-005: Instrument idempotency metrics and maintain runbooks

## Status
Accepted

## Date
2026-01-11

## Context
Ops teams need visibility into duplicates, lag, failures, and DLQ rates.

## Decision
Emit metrics:
- processed count, duplicate/skipped count
- failure count, retry count
- consumer lag (queue depth) and DLQ count
Maintain runbooks:
- how to replay messages safely
- how to inspect and remediate DLQ items

## Consequences
- improved reliability and faster incident response
- requires monitoring dashboards and alerting
