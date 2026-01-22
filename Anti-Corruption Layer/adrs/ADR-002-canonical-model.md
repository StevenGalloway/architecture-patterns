# ADR-002: Define an internal canonical customer model for integration

## Status
Accepted

## Date
2026-01-11

## Context
Vendor fields are inconsistent (naming, enums, optionality). Multiple internal consumers need a consistent representation of “Customer” that matches internal semantics, not vendor semantics.

## Decision
Define a **CanonicalCustomer** model owned by our domain:
- stable internal field names/types
- normalized enums and identifiers
- explicit optional fields (avoid implicit null semantics)
- mapping functions live in the ACL

## Consequences
- Improves internal consistency and reduces duplication
- Requires schema governance and documentation of mapping rules
