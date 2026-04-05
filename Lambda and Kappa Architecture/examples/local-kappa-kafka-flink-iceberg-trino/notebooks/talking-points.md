# Interview Talking Points: Lambda vs Kappa

## How I choose between Lambda and Kappa
- **Signal latency requirements** (seconds vs minutes/hours)
- **Reprocessing frequency** and cost
- **Event retention** (Kafka retention or archiving)
- **Complexity tolerance** (two code paths vs one)
- **Serving** needs (OLAP / interactive queries)

## Kappa replay/backfill strategy
- Reset offsets to a timestamp/offset and rerun
- Overwrite partitions / recompute windows
- Use versioned output tables for safe migration (v1→v2)

## Correctness considerations
- exactly-once where possible; otherwise idempotent sinks
- watermarking/late data handling
- schema evolution and compatibility enforcement
