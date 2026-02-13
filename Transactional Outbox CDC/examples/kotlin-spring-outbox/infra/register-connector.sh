#!/usr/bin/env bash
set -euo pipefail

CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"

cat <<'JSON' > /tmp/pg-outbox-connector.json
{
  "name": "pg-outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "tasks.max": "1",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "postgres",
    "database.password": "postgres",
    "database.dbname": "appdb",
    "database.server.name": "app",
    "plugin.name": "pgoutput",
    "slot.name": "debezium_outbox_slot",
    "publication.autocreate.mode": "filtered",
    "table.include.list": "public.outbox_events",
    "tombstones.on.delete": "false",
    "include.schema.changes": "false",
    "topic.prefix": "app",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "true",
    "transforms.unwrap.delete.handling.mode": "drop"
  }
}
JSON

curl -sS -X POST -H "Content-Type: application/json" --data @/tmp/pg-outbox-connector.json "${CONNECT_URL}/connectors" | jq .
echo "Connector registered. Kafka UI: http://localhost:8080 (topic: app.public.outbox_events)"
