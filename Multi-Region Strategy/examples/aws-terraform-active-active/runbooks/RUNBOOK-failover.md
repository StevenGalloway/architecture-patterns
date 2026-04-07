# Runbook: Multi-Region Failover (DNS-based)

## Objective
Validate that traffic shifts from Region A to Region B when Region A is unhealthy.

## Preconditions
- both regions deployed and passing health checks
- dashboards show normal baseline error/latency
- conservative DNS TTL (documented) and Route53 health checks enabled

## Drill Steps (Safe)
1. Establish baseline
   - Hit global FQDN repeatedly from multiple locations (or use synthetic probes)
   - Capture: success rate, latency, which region served

2. Induce failure in Region A (controlled)
   Options:
   - scale ECS service in Region A to 0
   - block ALB target group (security group) temporarily
   - simulate dependency failure (non-destructive)

3. Observe health checks
   - confirm Route53 marks Region A unhealthy
   - observe traffic shift to Region B after TTL/HC window

4. Validate correctness
   - ensure no user-facing errors beyond expected window
   - validate state access (e.g., session table) is consistent/available

5. Restore Region A
   - revert the change and confirm health check recovery
   - ensure traffic distribution returns to normal latency policy

## Success Criteria
- Failover occurs within the expected window (HC interval + TTL)
- Error rate stays within agreed thresholds
- No data correctness issues observed

## Post-Drill
- document learnings
- adjust thresholds, TTL, dashboards, and runbooks
