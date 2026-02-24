package com.example.caller;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Dedicated executor for async calls.
 * In production, prefer bounded queues and bulkheads to prevent resource exhaustion.
 */
@Configuration
public class ExecutorConfig {
  @Bean
  public Executor taskExecutor() {
    return Executors.newFixedThreadPool(16);
  }
}
