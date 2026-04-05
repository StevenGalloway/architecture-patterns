#!/usr/bin/env bash
set -euo pipefail

echo "Opening Trino CLI and querying Iceberg catalog."
echo "If the Flink job is running and writing to Iceberg, you can run:"
echo "  SHOW SCHEMAS FROM iceberg;"
echo "  SHOW TABLES FROM iceberg.default;"
echo "  SELECT * FROM iceberg.default.click_counts ORDER BY window_start DESC LIMIT 20;"
echo
docker exec -it $(docker ps --filter "name=trino" --format "{{.ID}}" | head -n1) trino
