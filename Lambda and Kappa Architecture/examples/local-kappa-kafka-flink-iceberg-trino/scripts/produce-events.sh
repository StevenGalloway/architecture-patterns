#!/usr/bin/env bash
set -euo pipefail

KAFKA_ID=$(docker ps --filter "name=kafka" --format "{{.ID}}" | head -n1)

cat <<'EOF' | docker exec -i $KAFKA_ID bash -lc "kafka-console-producer.sh --bootstrap-server kafka:9092 --topic clicks"
{"user_id":"u1","page":"/home","ts":"2026-01-11T12:00:00.000Z"}
{"user_id":"u2","page":"/home","ts":"2026-01-11T12:00:10.000Z"}
{"user_id":"u3","page":"/pricing","ts":"2026-01-11T12:00:20.000Z"}
{"user_id":"u1","page":"/home","ts":"2026-01-11T12:00:30.000Z"}
EOF

echo "Produced sample events to topic 'clicks'."
