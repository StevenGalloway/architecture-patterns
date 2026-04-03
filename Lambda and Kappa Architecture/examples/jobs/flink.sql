-- Flink SQL: Kappa-style stream -> Iceberg serving table
-- Run inside Flink SQL client with required connectors on classpath in real deployments.
-- For demo purposes, this shows the shape of the job.

-- 1) Source: Kafka topic `clicks` with JSON payload
CREATE TABLE clicks (
  user_id STRING,
  page STRING,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'clicks',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-clicks',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
);

-- 2) Sink: Iceberg table in Hive catalog
CREATE CATALOG hive WITH (
  'type'='hive',
  'default-database'='default',
  'hive-conf-dir'='/opt/flink/conf'
);

USE CATALOG hive;

CREATE TABLE IF NOT EXISTS click_counts (
  page STRING,
  window_start TIMESTAMP(3),
  window_end TIMESTAMP(3),
  cnt BIGINT
) WITH (
  'connector'='iceberg',
  'catalog-name'='hive',
  'catalog-type'='hive',
  'uri'='thrift://hive-metastore:9083',
  'warehouse'='s3a://warehouse/',
  'io-impl'='org.apache.iceberg.hadoop.HadoopFileIO'
);

-- 3) Streaming aggregation (tumbling window)
INSERT INTO click_counts
SELECT
  page,
  window_start,
  window_end,
  COUNT(*) as cnt
FROM TABLE(
  TUMBLE(TABLE clicks, DESCRIPTOR(ts), INTERVAL '1' MINUTE)
)
GROUP BY page, window_start, window_end;
