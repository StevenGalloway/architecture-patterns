package com.example.caller;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class DownstreamClient {
  private final RestClient rest;

  public DownstreamClient(@Value("${downstream.baseUrl}") String baseUrl) {
    this.rest = RestClient.builder().baseUrl(baseUrl).build();
  }

  public Map<String, Object> fetchData(String correlationId) {
    ResponseEntity<Map> resp = rest.get()
      .uri("/data")
      .header("X-Correlation-Id", correlationId)
      .retrieve()
      .toEntity(Map.class);

    Map<String, Object> body = resp.getBody();
    return Map.of(
      "ok", true,
      "correlation_id", correlationId,
      "received_at", Instant.now().toString(),
      "downstream", body
    );
  }

  public static String newCorrelationId() {
    return "corr-" + UUID.randomUUID();
  }
}
