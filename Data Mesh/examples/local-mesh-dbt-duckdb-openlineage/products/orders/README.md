# Orders Data Product (dbt project)

## What this builds
- Curated tables for the orders domain
- Basic dbt tests (not null, unique)
- Emits OpenLineage events to Marquez (configured via environment)

## Build
```bash
dbt deps
dbt build
```
