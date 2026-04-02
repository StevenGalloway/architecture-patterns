# Local Data Mesh Demo (dbt + DuckDB + OpenLineage/Marquez)

## Goal
Demonstrate “data product” concepts locally:
- domain-owned dbt projects (orders, customers)
- published contracts (YAML) and basic tests
- lineage capture via **OpenLineage** to **Marquez**

This is not a full enterprise mesh platform, but it shows the mechanics and artifacts recruiters/architects expect.

## Components
- DuckDB (local warehouse file)
- dbt (builds curated tables)
- Marquez (lineage API + UI)
- OpenLineage (emits run events to Marquez)

## Run
```bash
cd infra
docker compose up --build
```

## Build the Orders product
```bash
docker compose exec dbt-orders dbt deps
docker compose exec dbt-orders dbt build
```

## Build the Customers product
```bash
docker compose exec dbt-customers dbt deps
docker compose exec dbt-customers dbt build
```

## View lineage
Open Marquez UI:
- http://localhost:3000

## Notes
- In production, swap DuckDB for Snowflake/Databricks/BigQuery and use a real catalog/policy layer.
- Contracts should be validated in CI (schema + SLO metadata + classifications).
