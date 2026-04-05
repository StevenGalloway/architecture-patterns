# Local Kappa Demo (Kafka + Flink SQL + Iceberg + Trino)

## What you get
- Kafka topic for events (`clicks`)
- Flink SQL job that aggregates clicks per page and writes to an Iceberg table
- Trino configured to query Iceberg tables for serving/BI
- Simple scripts to create topic and produce demo events

## Prerequisites
- Docker + Docker Compose

## Start stack
```bash
cd infra
docker compose up -d
```

## Create topic and produce sample events
```bash
../scripts/create-topic.sh
../scripts/produce-events.sh
```

## Run Flink SQL job (aggregations to Iceberg)
```bash
../scripts/run-flink-sql.sh
```

## Query with Trino
```bash
../scripts/query-trino.sh
```

## Notes
- This is a simplified demonstration. Real systems include schema registry, exactly-once sinks, compaction, and quality checks.
- Replay/backfill: reset Flink offsets and rerun SQL or deploy corrected job version.
