# Infra Notes

This Compose stack starts:
- Kafka + Zookeeper
- MinIO (S3-compatible storage) + bucket `warehouse`
- Hive Metastore (backed by Postgres) pointing warehouse to MinIO
- Flink JobManager/TaskManager (base images)
- Trino with Iceberg connector configured for Hive Metastore + MinIO

For a full runnable end-to-end pipeline, mount the required Flink connector jars:
- Kafka SQL connector
- Iceberg Flink runtime
and run the provided `jobs/flink.sql` via Flink SQL client.

The goal of this pattern folder is to provide an impressive, production-mappable reference implementation and artifacts.
