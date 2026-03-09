import json
import os
import time
from typing import Any, Dict, Optional

import psycopg
import redis
from fastapi import FastAPI, HTTPException, Response

APP_ENV = os.getenv("APP_ENV", "dev")
TENANT = os.getenv("TENANT", "public")
KEY_VERSION = os.getenv("KEY_VERSION", "v1")

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
DB_DSN = os.getenv("DB_DSN", "postgresql://postgres:postgres@db:5432/appdb")

FRESH_TTL_SECONDS = int(os.getenv("FRESH_TTL_SECONDS", "10"))
STALE_TTL_SECONDS = int(os.getenv("STALE_TTL_SECONDS", "60"))
NEGATIVE_TTL_SECONDS = int(os.getenv("NEGATIVE_TTL_SECONDS", "5"))
LOCK_TTL_SECONDS = int(os.getenv("LOCK_TTL_SECONDS", "3"))

r = redis.Redis.from_url(REDIS_URL, decode_responses=True)

app = FastAPI(title="Caching Strategies Demo", version="0.1.0")


def k(entity: str, entity_id: Any, suffix: str = "") -> str:
    base = f"{APP_ENV}:{TENANT}:{KEY_VERSION}:{entity}:{entity_id}"
    return base if not suffix else f"{base}:{suffix}"


def db_get_product(pid: int) -> Optional[Dict[str, Any]]:
    with psycopg.connect(DB_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, price, updated_at FROM products WHERE id=%s", (pid,))
            row = cur.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "name": row[1],
                "price": float(row[2]),
                "updated_at": row[3].isoformat(),
            }


def cache_set_product(pid: int, data: Dict[str, Any]) -> None:
    payload = json.dumps(data)
    r.setex(k("product", pid), FRESH_TTL_SECONDS, payload)
    r.setex(k("product", pid, "stale"), STALE_TTL_SECONDS, payload)


def cache_set_negative(pid: int) -> None:
    r.setex(k("product", pid, "nf"), NEGATIVE_TTL_SECONDS, "1")


def is_negative_cached(pid: int) -> bool:
    return r.exists(k("product", pid, "nf")) == 1


def try_lock(pid: int) -> bool:
    return bool(r.set(k("product", pid, "lock"), "1", nx=True, ex=LOCK_TTL_SECONDS))


def unlock(pid: int) -> None:
    r.delete(k("product", pid, "lock"))


def get_cached(pid: int) -> Optional[Dict[str, Any]]:
    v = r.get(k("product", pid))
    return json.loads(v) if v else None


def get_stale(pid: int) -> Optional[Dict[str, Any]]:
    v = r.get(k("product", pid, "stale"))
    return json.loads(v) if v else None


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/products/{pid}")
def get_product(pid: int, response: Response) -> Dict[str, Any]:
    # Negative caching (not found)
    if is_negative_cached(pid):
        response.headers["X-Cache"] = "NEGATIVE-HIT"
        raise HTTPException(status_code=404, detail="Product not found")

    # Fresh cache
    try:
        cached = get_cached(pid)
        if cached:
            response.headers["X-Cache"] = "HIT"
            return cached
    except Exception:
        # Cache outage -> origin
        response.headers["X-Cache"] = "CACHE-ERROR"
        prod = db_get_product(pid)
        if not prod:
            raise HTTPException(status_code=404, detail="Product not found")
        return prod

    response.headers["X-Cache"] = "MISS"

    # Stampede protection
    got_lock = False
    try:
        got_lock = try_lock(pid)
    except Exception:
        prod = db_get_product(pid)
        if not prod:
            raise HTTPException(status_code=404, detail="Product not found")
        return prod

    if got_lock:
        try:
            prod = db_get_product(pid)
            if not prod:
                try:
                    cache_set_negative(pid)
                except Exception:
                    pass
                raise HTTPException(status_code=404, detail="Product not found")

            try:
                cache_set_product(pid, prod)
                response.headers["X-Cache"] = "MISS-REFRESHED"
            except Exception:
                response.headers["X-Cache"] = "MISS-REFRESHED-CACHE-ERROR"
            return prod
        finally:
            try:
                unlock(pid)
            except Exception:
                pass

    # SWR: serve stale while another worker refreshes
    try:
        stale = get_stale(pid)
        if stale:
            response.headers["X-Cache"] = "STALE"
            response.headers["X-Cache-Stale"] = "true"
            return stale
    except Exception:
        pass

    # No stale: origin fallback
    prod = db_get_product(pid)
    if not prod:
        try:
            cache_set_negative(pid)
        except Exception:
            pass
        raise HTTPException(status_code=404, detail="Product not found")
    return prod


@app.post("/admin/products/{pid}/price")
def update_price(pid: int, price: float) -> Dict[str, Any]:
    # Update origin
    with psycopg.connect(DB_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE products SET price=%s, updated_at=now() WHERE id=%s", (price, pid))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Product not found")
        conn.commit()

    # Invalidate cache keys (TTL-only demo). Production: publish invalidation event.
    try:
        r.delete(k("product", pid), k("product", pid, "stale"), k("product", pid, "nf"))
    except Exception:
        pass

    return {"ok": True, "id": pid, "price": price}
