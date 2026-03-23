const port = Number(process.env.PORT ?? "8080");
const version = process.env.VERSION ?? "v1";
const errorRate = Number(process.env.ERROR_RATE ?? "0.0");
const rng = Math.random;

Bun.serve({
  port,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");

    if (url.pathname === "/api/data") {
      // Simulate occasional failures to demonstrate retries/timeouts via mesh policy
      if (Math.random() < errorRate) {
        return new Response(JSON.stringify({ ok: false, version, error: "simulated" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }

      // Simulate variable latency (for timeout demonstrations)
      const delayMs = Number(url.searchParams.get("delay") ?? "30");
      await new Promise((r) => setTimeout(r, delayMs));

      return Response.json({
        ok: true,
        service: "backend",
        version,
        host: process.env.HOSTNAME ?? "unknown",
        delay_ms: delayMs,
        ts: new Date().toISOString(),
      });
    }

    return new Response("not found\n", { status: 404 });
  }
});

console.log(`backend ${version} listening on :${port} (errorRate=${errorRate})`);
