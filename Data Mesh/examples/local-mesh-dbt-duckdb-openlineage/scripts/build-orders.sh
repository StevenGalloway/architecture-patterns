#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cd infra
docker compose exec dbt-orders bash -lc "dbt deps && openlineage-dbt --dbt-command 'dbt build' --transport http --url http://marquez:5000 --namespace local-mesh"
