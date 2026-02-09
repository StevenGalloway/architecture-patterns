# ADR-002: Use RabbitMQ with at-least-once delivery semantics

## Status
Accepted

## Date
2026-01-11

## Context
Service coordination is asynchronous and must tolerate transient failures. We need reliable delivery and backpressure.

## Decision
Use RabbitMQ:
- commands delivered to per-service queues
- services publish events to an exchange consumed by the orchestrator
- assume **at-least-once** delivery → duplicates are expected

## Consequences
- reliable async communication with queueing and backpressure
- requires idempotency and dedupe handling in all services and orchestrator
