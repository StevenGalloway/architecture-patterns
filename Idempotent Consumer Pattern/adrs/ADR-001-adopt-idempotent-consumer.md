# ADR-001: Adopt Idempotent Consumer for asynchronous processing

## Status
Accepted

## Date
2026-01-11

## Context
Our broker delivery is at-least-once. Retries and redeliveries can cause duplicate processing and duplicate side effects.

## Decision
Implement the **Idempotent Consumer** pattern:
- every message has a stable `message_id`
- the consumer checks a dedupe store before performing side effects
- duplicates are acknowledged and skipped

## Consequences
- eliminates duplicate side effects under retries
- requires a dedupe store and retention policy
