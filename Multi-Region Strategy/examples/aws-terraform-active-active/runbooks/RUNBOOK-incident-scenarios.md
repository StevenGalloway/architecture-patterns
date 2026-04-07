# Runbook: Multi-Region Incident Scenarios

## Scenario A: Partial regional degradation
Symptoms:
- elevated latency, intermittent 5xx
Actions:
- confirm regional health check behavior
- consider shifting weights/health check sensitivity
- mitigate upstream dependencies (rate limit, circuit breakers)

## Scenario B: Split-brain writes / conflict risk
Symptoms:
- inconsistent reads or last-write-wins surprises
Actions:
- validate which stores are multi-writer (e.g., Global Tables)
- apply conflict strategy: idempotent updates, version stamps, monotonic timestamps

## Scenario C: Replication lag (primary/replica designs)
Symptoms:
- stale reads in secondary region
Actions:
- failover only when lag below threshold
- switch clients to read-your-writes or route writes to primary

## Scenario D: DNS failover slow
Symptoms:
- users continue hitting unhealthy endpoint
Actions:
- tune TTL and health check intervals
- consider AWS Global Accelerator for faster steering
