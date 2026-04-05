#!/usr/bin/env bash
set -euo pipefail
docker exec -i $(docker ps --filter "name=kafka" --format "{{.ID}}" | head -n1)   bash -lc "kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic clicks --partitions 1 --replication-factor 1"
echo "Topic 'clicks' ready."
