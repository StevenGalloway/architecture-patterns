import os
import json
import uuid
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from db import connect, db_path

DATA_DIR = os.getenv("DATA_DIR", "./data")
EVENT_DB = db_path(DATA_DIR, "event_store.db")

app = FastAPI(title="Event Sourcing Command API")

def init_event_store() -> None:
    conn = connect(EVENT_DB)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        correlation_id TEXT,
        payload_json TEXT NOT NULL
      )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_agg ON events(aggregate_id, aggregate_version)")
    conn.commit()
    conn.close()

init_event_store()

def load_events(aggregate_id: str):
    conn = connect(EVENT_DB)
    rows = conn.execute(
        "SELECT * FROM events WHERE aggregate_id=? ORDER BY aggregate_version ASC",
        (aggregate_id,)
    ).fetchall()
    conn.close()
    return rows

def current_version(aggregate_id: str) -> int:
    conn = connect(EVENT_DB)
    row = conn.execute(
        "SELECT MAX(aggregate_version) AS v FROM events WHERE aggregate_id=?",
        (aggregate_id,)
    ).fetchone()
    conn.close()
    return int(row["v"] or 0)

def append_event(
    aggregate_id: str,
    expected_version: int,
    evt_type: str,
    evt_payload: dict,
    evt_version: int = 1,
    correlation_id: Optional[str] = None
):
    curr = current_version(aggregate_id)
    if curr != expected_version:
        raise HTTPException(
            status_code=409,
            detail=f"Concurrency conflict: expected_version={expected_version}, current_version={curr}"
        )

    new_ver = curr + 1
    event_id = str(uuid.uuid4())
    occurred_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    conn = connect(EVENT_DB)
    try:
        conn.execute(
            """INSERT INTO events(event_id,type,version,occurred_at,aggregate_id,aggregate_version,correlation_id,payload_json)
               VALUES(?,?,?,?,?,?,?,?)""",
            (event_id, evt_type, evt_version, occurred_at, aggregate_id, new_ver, correlation_id, json.dumps(evt_payload))
        )
        conn.commit()
    finally:
        conn.close()

    return event_id, new_ver

def rehydrate_account(aggregate_id: str):
    events = load_events(aggregate_id)
    state = {"account_id": aggregate_id, "owner": None, "balance": 0.0, "is_open": False, "version": 0}
    for e in events:
        payload = json.loads(e["payload_json"])
        if e["type"] == "AccountOpened":
            state["owner"] = payload["owner"]
            state["is_open"] = True
        elif e["type"] == "MoneyDeposited":
            state["balance"] += float(payload["amount"])
        elif e["type"] == "MoneyWithdrawn":
            state["balance"] -= float(payload["amount"])
        state["version"] = int(e["aggregate_version"])
    return state

class OpenAccount(BaseModel):
    owner: str = Field(min_length=1)
    expected_version: int = 0

class MoneyCommand(BaseModel):
    amount: float = Field(gt=0)
    expected_version: int

@app.post("/accounts/{account_id}/open")
def open_account(account_id: str, cmd: OpenAccount):
    st = rehydrate_account(account_id)
    if st["version"] != cmd.expected_version:
        raise HTTPException(status_code=409, detail=f"Concurrency conflict: expected_version={cmd.expected_version}, current_version={st['version']}")
    if st["is_open"]:
        raise HTTPException(status_code=400, detail="Account already opened")

    event_id, new_version = append_event(
        aggregate_id=account_id,
        expected_version=cmd.expected_version,
        evt_type="AccountOpened",
        evt_payload={"owner": cmd.owner},
        evt_version=1
    )
    return {"ok": True, "event_id": event_id, "new_version": new_version}

@app.post("/accounts/{account_id}/deposit")
def deposit(account_id: str, cmd: MoneyCommand):
    st = rehydrate_account(account_id)
    if not st["is_open"]:
        raise HTTPException(status_code=400, detail="Account not opened")

    event_id, new_version = append_event(
        aggregate_id=account_id,
        expected_version=cmd.expected_version,
        evt_type="MoneyDeposited",
        evt_payload={"amount": cmd.amount},
        evt_version=1
    )
    return {"ok": True, "event_id": event_id, "new_version": new_version}

@app.post("/accounts/{account_id}/withdraw")
def withdraw(account_id: str, cmd: MoneyCommand):
    st = rehydrate_account(account_id)
    if not st["is_open"]:
        raise HTTPException(status_code=400, detail="Account not opened")
    if st["balance"] < cmd.amount:
        raise HTTPException(status_code=400, detail="Insufficient funds")

    event_id, new_version = append_event(
        aggregate_id=account_id,
        expected_version=cmd.expected_version,
        evt_type="MoneyWithdrawn",
        evt_payload={"amount": cmd.amount},
        evt_version=1
    )
    return {"ok": True, "event_id": event_id, "new_version": new_version}

@app.get("/healthz")
def healthz():
    return {"ok": True}
