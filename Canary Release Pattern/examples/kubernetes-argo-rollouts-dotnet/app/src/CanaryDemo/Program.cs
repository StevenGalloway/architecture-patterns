using System.Diagnostics;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var version = Environment.GetEnvironmentVariable("VERSION") ?? "dev";
var errorRateRaw = Environment.GetEnvironmentVariable("ERROR_RATE") ?? "0.0";
double errorRate = double.TryParse(errorRateRaw, out var er) ? er : 0.0;
var rng = new Random();

app.MapGet("/", () => Results.Json(new {
    ok = true,
    version,
    host = Environment.MachineName,
    ts = DateTimeOffset.UtcNow
}));

app.MapGet("/healthz", () => Results.Json(new { ok = true, version }));

// Simulate an endpoint that can regress (error rate based on env var)
app.MapGet("/api/data", () =>
{
    if (rng.NextDouble() < errorRate)
        return Results.Problem("simulated error", statusCode: 500);

    return Results.Json(new { ok = true, version, value = "hello", ts = DateTimeOffset.UtcNow });
});

// Simple metric endpoint for canary analysis (web metric provider)
// In real life, analysis should query Prometheus or an APM platform.
app.MapGet("/rollout-metric", () => Results.Json(new {
    version,
    error_rate = errorRate,
    // This is intentionally simple: analysis checks error_rate < threshold.
    note = "demo metric; replace with real SLO signals in production"
}));

app.Run();
