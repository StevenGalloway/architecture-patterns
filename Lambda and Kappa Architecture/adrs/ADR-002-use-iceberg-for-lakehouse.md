# ADR-002: Use Iceberg as the lakehouse table format

## Status
Accepted

## Date
2026-01-11

## Context
We need reliable table format semantics for streaming + batch reads, schema evolution, and efficient queries.

## Decision
Use **Apache Iceberg** for curated tables and aggregates.

## Consequences
- strong interoperability (Flink/Trino/Spark)
- requires catalog configuration and compaction/maintenance processes
