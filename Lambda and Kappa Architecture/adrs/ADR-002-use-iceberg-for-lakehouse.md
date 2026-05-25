# ADR-002: Use Iceberg as the lakehouse table format

## Status
Accepted

## Date
2025-08-27

## Context
The Kappa architecture produces two categories of output: raw event data (retained in Kafka and S3) and curated aggregate tables (materialized results consumed by BI tools and dashboards). The curated tables required a storage format that could support several competing requirements simultaneously:

**Concurrent streaming writes and batch reads:** The Flink streaming job writes results to curated tables continuously. Business analysts and BI tools read from the same tables via a query engine (Trino). The storage format needed to support concurrent writes and reads without locking or read-after-write inconsistency.

**Schema evolution without table recreation:** As business requirements evolve, the schema of curated tables changes. Adding new columns, changing data types for historical compatibility, and evolving partition strategies all need to work without dropping and recreating the table (which would lose history).

**Efficient partition pruning for large tables:** The daily active user table accumulates rows for every day of data. A query for "last 7 days" should not scan the full table history. Partition pruning by date is essential for query performance.

**ACID guarantees for overwrite operations:** When a backfill overwrites a specific time range (correcting a historical metric), the overwrite must be atomic -- readers should see either the old data or the new data, not a partial mix of both during the overwrite.

The initial implementation used Parquet files on S3 with a Hive metastore for table metadata. This worked for batch reads but had no ACID semantics: concurrent Flink writes could produce corrupt table state if two jobs wrote to overlapping partitions simultaneously. Schema evolution required schema-on-read workarounds.

## Decision
Use **Apache Iceberg** as the table format for all curated aggregate tables and any raw event tables that require schema evolution or query access.

Iceberg provides:
- **ACID transactions** via optimistic concurrency on table snapshots. Concurrent writes produce separate snapshots; Flink and batch jobs operate on named branches or sequential snapshots without corrupting each other.
- **Schema evolution** without rewriting existing data. New columns can be added with defaults; column renames are tracked in the schema history. Old Parquet files remain readable under the old schema.
- **Time travel** for reading the table as of a specific snapshot or timestamp. Useful for debugging (what did the daily revenue table contain at 2 AM before the backfill?) and for deterministic replay (process the table as it existed at a specific point in time).
- **Partition evolution**: partition strategies can be changed without rewriting existing data. Adding a month-level partition on top of an existing day-level partition is a metadata operation.

The Iceberg catalog is managed via a Nessie server (providing Git-like branching semantics for table operations), with Trino and Flink both configured to use the same Nessie catalog.

## Alternatives Considered

**Apache Hudi instead of Iceberg:** Hudi is an alternative open table format with similar ACID semantics and CDC support. Rejected because Hudi's primary optimization is for record-level upserts (useful for CDC pipelines), while the analytics use case is predominantly append-heavy with occasional time-range overwrites. Iceberg's snapshot-based model is a better fit for append and overwrite patterns. Hudi's merge-on-read architecture adds overhead for pure-read query workloads.

**Delta Lake instead of Iceberg:** Delta Lake has strong Spark ecosystem support and is the default format in Databricks. Rejected because the team's query engine is Trino, and Delta Lake's non-Apache-licensed features (like Deletion Vectors) have historically had slower community support in Trino than Iceberg. Iceberg's ecosystem breadth (Flink, Trino, Spark, Nessie) is more appropriate for a multi-engine environment.

**Parquet on S3 with Hive Metastore (status quo):** No migration, continue with existing tooling. Rejected because the ACID requirements cannot be met with Hive Metastore partitioned Parquet: concurrent writes cause data corruption and schema evolution requires manual workarounds that are operationally fragile.

## Consequences

### Positive
- Concurrent Flink streaming writes and Trino queries operate correctly without data corruption; Iceberg's snapshot isolation prevents the concurrent write corruption that affected the Hive Metastore approach
- Schema evolution for curated tables is a metadata operation; adding a new metric column to the daily revenue table does not require rewriting 2 years of Parquet files
- Time travel enables deterministic debugging and auditing: analysts can query historical table state as of a specific timestamp

### Negative
- Iceberg table maintenance (compaction, expired snapshot cleanup, orphan file cleanup) requires scheduled jobs. Without maintenance, table metadata files and snapshot history accumulate indefinitely, degrading query planning performance
- The Nessie catalog server is a new infrastructure dependency; Nessie availability affects all Iceberg table reads and writes

### Risks
- **Compaction lag causing query performance degradation.** If the compaction job falls behind (many small Flink output files not merged into larger files), Trino queries that scan small files take significantly longer than queries scanning the same data in compacted form. Mitigation: compaction job runs every 6 hours; an alert fires if the average file size in any partition drops below 64MB (indicating compaction is not keeping up with write volume).

## Review Trigger
Revisit if the primary query engine changes from Trino to a Spark-native environment, at which point Delta Lake's Spark ecosystem advantages may outweigh Iceberg's broader multi-engine support.
