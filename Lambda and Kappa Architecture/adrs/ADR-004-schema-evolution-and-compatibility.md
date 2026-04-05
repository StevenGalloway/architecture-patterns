# ADR-004: Enforce schema evolution and compatibility rules

## Status
Accepted

## Date
2026-01-11

## Context
Streaming systems break when producers and consumers evolve schemas inconsistently.

## Decision
- define schema contracts per topic (Avro/Protobuf/JSON Schema)
- enforce compatibility checks in CI and registry (backward/forward rules)
- treat breaking changes as new topics or versioned schemas

## Consequences
- safer evolution and fewer runtime failures
- requires governance and tooling for schema management
