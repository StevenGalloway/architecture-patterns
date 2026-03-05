local cjson = require "cjson.safe"
local limit_req = require "resty.limit.req"
local redis = require "resty.redis"

-- -------- Config (demo-friendly) --------
local IP_RATE_PER_SEC = tonumber(os.getenv("IP_RATE_PER_SEC") or "5")   -- sustained rate
local IP_BURST = tonumber(os.getenv("IP_BURST") or "10")               -- burst size

local QUOTA_PER_DAY = tonumber(os.getenv("QUOTA_PER_DAY") or "200")    -- per API key/day
local REDIS_HOST = os.getenv("REDIS_HOST") or "redis"
local REDIS_PORT = tonumber(os.getenv("REDIS_PORT") or "6379")

-- -------- Helpers --------
local function send_json(status, body, headers)
  ngx.status = status
  ngx.header["Content-Type"] = "application/json"
  if headers then
    for k, v in pairs(headers) do ngx.header[k] = v end
  end
  ngx.say(cjson.encode(body))
  return ngx.exit(status)
end

local function today_utc()
  return os.date("!%Y-%m-%d")
end

-- -------- 1) Auth / identify client --------
local api_key = ngx.req.get_headers()["X-API-Key"]
if not api_key or api_key == "" then
  return send_json(401, { ok=false, error="missing_api_key", hint="provide X-API-Key" })
end

-- -------- 2) Per-IP token bucket (local) --------
-- Uses lua_shared_dict ip_limit_store (per edge instance).
local lim, err = limit_req.new("ip_limit_store", IP_RATE_PER_SEC, IP_BURST)
if not lim then
  -- If local limiter can't initialize, fail open but log loudly.
  ngx.log(ngx.ERR, "failed to init ip limiter: ", err)
else
  local key = ngx.var.binary_remote_addr -- per-IP
  local delay, err2 = lim:incoming(key, true) -- commit = true
  if not delay then
    if err2 == "rejected" then
      return send_json(
        429,
        { ok=false, error="rate_limited", scope="ip", api_key=api_key },
        { ["Retry-After"] = "1" }
      )
    end
    ngx.log(ngx.ERR, "ip limiter error: ", err2)
  else
    -- Optional: we could sleep(delay) to smooth; for edge, prefer reject on excess.
    -- If delay > 0, it indicates we are within burst and could delay.
    -- For demo, do not delay; pass through.
  end
end

-- -------- 3) Per-API-key daily quota (global via Redis) --------
local red = redis:new()
red:set_timeout(200) -- ms

local ok, err3 = red:connect(REDIS_HOST, REDIS_PORT)
if not ok then
  -- Decide fail-open vs fail-closed depending on endpoint risk.
  -- Here: fail-closed for protected API, because quota enforcement is part of contract.
  ngx.log(ngx.ERR, "redis connect failed: ", err3)
  return send_json(503, { ok=false, error="rate_limit_backend_unavailable" })
end

local day = today_utc()
local quota_key = "quota:" .. api_key .. ":" .. day

local current, err4 = red:incr(quota_key)
if not current then
  ngx.log(ngx.ERR, "redis incr failed: ", err4)
  return send_json(503, { ok=false, error="rate_limit_backend_error" })
end

-- Set TTL to 2 days (safety) on first increment so keys expire
if current == 1 then
  red:expire(quota_key, 2 * 24 * 60 * 60)
end

local remaining = QUOTA_PER_DAY - current
local reset_in = 24 * 60 * 60 -- simplistic: daily window; production should compute seconds to midnight UTC

-- Attach rate headers (quota view)
ngx.header["X-RateLimit-Limit"] = tostring(QUOTA_PER_DAY)
ngx.header["X-RateLimit-Remaining"] = tostring(math.max(0, remaining))
ngx.header["X-RateLimit-Reset"] = tostring(reset_in)

if current > QUOTA_PER_DAY then
  return send_json(
    429,
    { ok=false, error="quota_exceeded", scope="api_key", api_key=api_key, limit=QUOTA_PER_DAY },
    { ["Retry-After"] = tostring(reset_in) }
  )
end

-- Put redis connection back to pool
red:set_keepalive(10_000, 50)
