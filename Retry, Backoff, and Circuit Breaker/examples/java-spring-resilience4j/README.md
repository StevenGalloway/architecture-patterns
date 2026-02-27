# Retry + Backoff + Circuit Breaker Example (Java 21 + Spring Boot + Resilience4j)

## Components
- `downstream-flaky` (port 9101): randomly returns 500s or delays
- `caller-service` (port 9100): calls downstream with retry + timeouts + circuit breaker, with fallback

## Run
```bash
cd infra
docker compose up --build
```

## Try it
```bash
curl http://localhost:9100/proxy/data
```

## Metrics / Debug
```bash
curl http://localhost:9100/actuator/health
curl http://localhost:9100/actuator/metrics/resilience4j.circuitbreaker.state
curl http://localhost:9100/actuator/metrics/resilience4j.retry.calls
```

Rabbit-hole for tuning:
- failureRateThreshold, slowCallRateThreshold
- timeoutDuration vs slowCallDurationThreshold
- maxAttempts, backoff multiplier, jitter factor
