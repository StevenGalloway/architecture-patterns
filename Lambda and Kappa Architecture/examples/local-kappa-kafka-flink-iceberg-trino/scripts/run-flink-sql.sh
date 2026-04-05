#!/usr/bin/env bash
set -euo pipefail

echo "This repo includes jobs/flink.sql showing the intended Flink SQL job."
echo
echo "Running Flink SQL with Kafka + Iceberg connectors requires mounting connector jars into Flink."
echo "To keep the demo repo lightweight and portable, we provide the SQL and the architecture artifacts."
echo
echo "Production note: add flink-sql-connector-kafka + iceberg-flink-runtime jars and run:"
echo "  ./bin/sql-client.sh -f /path/to/flink.sql"
