const port = Number(process.env.PORT ?? "9800");
const backendUrl = process.env.BACKEND_URL ?? "http://backend.canary-mesh.svc.cluster.local:8080";

Bun.serve({
  port,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");

    if (url.pathname === "/") {
      const res = await fetch(`${backendUrl}/api/data`, {
        headers: { "x-request-id": crypto.randomUUID() }
      });
      const data = await res.json();
      return Response.json({
        ok: true,
        service: "frontend",
        backend: data,
        ts: new Date().toISOString(),
      });
    }

    return new Response("not found\n", { status: 404 });
  }
});

console.log(`frontend listening on :${port}, backend=${backendUrl}`);
