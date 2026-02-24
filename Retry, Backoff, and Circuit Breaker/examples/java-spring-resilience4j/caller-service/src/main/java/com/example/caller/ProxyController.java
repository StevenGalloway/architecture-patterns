package com.example.caller;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import io.github.resilience4j.timelimiter.annotation.TimeLimiter;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProxyController {
  private final DownstreamClient client;
  private final Executor executor;

  public ProxyController(DownstreamClient client, Executor taskExecutor) {
    this.client = client;
    this.executor = taskExecutor;
  }

  @GetMapping("/proxy/data")
  @Retry(name = "downstreamRetry", fallbackMethod = "fallback")
  @CircuitBreaker(name = "downstreamCB", fallbackMethod = "fallback")
  @TimeLimiter(name = "downstreamTimeLimiter", fallbackMethod = "fallbackAsync")
  public CompletionStage<Map<String, Object>> proxy() {
    String corr = DownstreamClient.newCorrelationId();
    return CompletableFuture.supplyAsync(() -> client.fetchData(corr), executor);
  }

  // Fallback for Retry/CircuitBreaker (async)
  private CompletionStage<Map<String, Object>> fallback(Throwable t) {
    return CompletableFuture.completedFuture(fallbackBody(t));
  }

  // Fallback for TimeLimiter signature includes the same args as proxy + Throwable.
  private CompletionStage<Map<String, Object>> fallbackAsync(Throwable t) {
    return CompletableFuture.completedFuture(fallbackBody(t));
  }

  private Map<String, Object> fallbackBody(Throwable t) {
    return Map.of(
      "ok", true,
      "mode", "fallback",
      "reason", t.getClass().getSimpleName(),
      "message", String.valueOf(t.getMessage()),
      "ts", Instant.now().toString(),
      "hint", "Breaker may be OPEN or retries exhausted; check /actuator/metrics for resilience4j.*"
    );
  }
}
