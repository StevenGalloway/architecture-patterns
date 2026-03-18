# ADR-002: Use traffic splitting at the ingress/gateway layer

## Status
Accepted

## Date
2026-01-11

## Context
Canary requires deterministic control of traffic weights and the ability to route to stable/canary replica sets.

## Decision
Use an ingress/gateway mechanism supported by the platform (e.g., Argo Rollouts + supported ingress/mesh) for weight-based routing.

## Consequences
- consistent rollout mechanics across services
- adds dependency on ingress capabilities and controller config
