package com.example.downstream;

import java.time.Instant;
import java.util.Map;
import java.util.Random;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DataController {
  private final Random rnd = new Random();

  @GetMapping("/data")
  public Map<String, Object> data() throws InterruptedException {
    int p = rnd.nextInt(100);

    // ~25% error rate
    if (p < 25) {
      throw new RuntimeException("simulated downstream 500");
    }

    // ~25% slow response (to trigger timeouts/slow calls)
    if (p >= 25 && p < 50) {
      Thread.sleep(1200);
    }

    return Map.of(
      "ok", true,
      "downstream", "downstream-flaky",
      "ts", Instant.now().toString(),
      "sample", p
    );
  }
}
