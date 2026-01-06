# Architecture Patterns

This repository documents real-world architecture decisions using a consistent framework:

**Problem → Constraints → Solution → Tradeoffs → Failure Modes → When Not To Use**

The goal is to demonstrate architectural thinking, not just diagrams.

---

## Pattern Index

| Pattern | Focus |
|--------|------|
| Event-Driven Systems | Latency vs complexity |
| Caching Strategies | Performance vs consistency |
| CQRS | Read/write separation & scaling |
| Strangler Fig | Legacy modernization with risk control |
| Saga Pattern | Distributed transaction management |

---

## Standard Structure

Each pattern folder contains:
- `README.md` – narrative design walkthrough
- `diagram/` – architecture diagram
- `adr/` – Architecture Decision Records
- `example/` – minimal reference implementation

---

## What This Demonstrates
- Tradeoff-driven design
- Scalability and reliability considerations
- Failure mode analysis
- Practical modernization strategies
