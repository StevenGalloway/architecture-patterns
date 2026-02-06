import os
from fastapi import FastAPI
from db import connect, db_path

DATA_DIR = os.getenv("DATA_DIR", "./data")
READ_DB = db_path(DATA_DIR, "read_model.db")

app = FastAPI(title="Event Sourcing Query API")

def init_read_db_if_needed() -> None:
    conn = connect(READ_DB)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS account_read (
        account_id TEXT PRIMARY KEY,
        owner TEXT,
        balance REAL NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    """)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS account_timeline (
        event_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL
      )
    """)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS projector_cursor (
        id INTEGER PRIMARY KEY CHECK (id=1),
        last_event_row_id INTEGER NOT NULL
      )
    """)
    conn.execute("INSERT OR IGNORE INTO projector_cursor(id,last_event_row_id) VALUES(1,0)")
    conn.commit()
    conn.close()

init_read_db_if_needed()

@app.get("/accounts/{account_id}")
def get_account(account_id: str):
    conn = connect(READ_DB)
    row = conn.execute("SELECT * FROM account_read WHERE account_id=?", (account_id,)).fetchone()
    conn.close()
    if not row:
        return {"found": False, "message": "Not found (projection may be behind)"}
    return {"found": True, "account": dict(row)}

@app.get("/accounts/{account_id}/timeline")
def get_timeline(account_id: str):
    conn = connect(READ_DB)
    rows = conn.execute(
        "SELECT * FROM account_timeline WHERE account_id=? ORDER BY aggregate_version ASC",
        (account_id,)
    ).fetchall()
    conn.close()
    return {"items": [dict(r) for r in rows]}

@app.get("/metrics")
def metrics():
    conn = connect(READ_DB)
    cursor = conn.execute("SELECT last_event_row_id FROM projector_cursor WHERE id=1").fetchone()["last_event_row_id"]
    accounts = conn.execute("SELECT COUNT(*) AS c FROM account_read").fetchone()["c"]
    conn.close()
    return {"projector_last_event_row_id": int(cursor), "accounts_indexed": int(accounts)}

@app.get("/healthz")
def healthz():
    return {"ok": True}
