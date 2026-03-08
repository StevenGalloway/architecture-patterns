import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const port = 9400;

serve((req) => {
  const url = new URL(req.url);
  const apiKey = req.headers.get("x-api-key") ?? "";
  const requestId = req.headers.get("x-request-id") ?? "";

  if (url.pathname === "/health") {
    return new Response("ok\n");
  }

  const body = {
    ok: true,
    service: "deno-backend",
    path: url.pathname,
    request_id: requestId,
    api_key_present: apiKey.length > 0,
    ts: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}, { port });

console.log(`deno service listening on ${port}`);
