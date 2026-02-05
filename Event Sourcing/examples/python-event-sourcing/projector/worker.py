import os
import json
import time

from db import connect, db_path

DATA_DIR = os.getenv("DATA_DIR", "./data")
POLL_INTERVAL_MS = int(os.getenv("POLL_INTERVAL_MS", "250"))

EVENT_DB = db_path(DATA_DIR, "event_store.db")
READ_DB = db_path(DATA_DIR, "read_model.db")

def init_event_store_if_needed():
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
    conn.commit()
    conn.close()

def init_read_model():
    conn = connect(READ_DB)
    cur = conn.cursor()
    cur.execute("""
      CREATE TABLE IF NOT EXISTS account_read (
        account_id TEXT PRIMARY KEY,
        owner TEXT,
        balance REAL NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    """)
    cur.execute("""
      CREATE TABLE IF NOT EXISTS account_timeline (
        event_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL
      )
    """)
    cur.execute("""
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    """)
    cur.execute("""
      CREATE TABLE IF NOT EXISTS projector_cursor (
        id INTEGER PRIMARY KEY CHECK (id=1),
        last_event_row_id INTEGER NOT NULL
      )
    """)
    cur.execute("INSERT OR IGNORE INTO projector_cursor(id,last_event_row_id) VALUES(1,0)")
    conn.commit()
    conn.close()

def get_cursor(conn) -> int:
    row = conn.execute("SELECT last_event_row_id FROM projector_cursor WHERE id=1").fetchone()
    return int(row["last_event_row_id"])

def set_cursor(conn, row_id: int) -> None:
    conn.execute("UPDATE projector_cursor SET last_event_row_id=? WHERE id=1", (row_id,))

def already_processed(conn, event_id: str) -> bool:
    row = conn.execute("SELECT 1 FROM processed_events WHERE event_id=?", (event_id,)).fetchone()
    return row is not None

def mark_processed(conn, event_id: str, applied_at: str) -> None:
    conn.execute("INSERT INTO processed_events(event_id, applied_at) VALUES(?,?)", (event_id, applied_at))

def upsert_account(conn, account_id: str, owner, balance: float, version: int, updated_at: str) -> None:
    conn.execute("""
      INSERT INTO account_read(account_id, owner, balance, version, updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET
        owner=excluded.owner,
        balance=excluded.balance,
        version=excluded.version,
        updated_at=excluded.updated_at
    """, (account_id, owner, balance, version, updated_at))

def insert_timeline(conn, event_id: str, account_id: str, agg_version: int, typ: str, occurred_at: str, summary: str) -> None:
    conn.execute("""
      INSERT OR IGNORE INTO account_timeline(event_id, account_id, aggregate_version, type, occurred_at, summary)
      VALUES(?,?,?,?,?,?)
    """, (event_id, account_id, agg_version, typ, occurred_at, summary))

def apply_event(conn, e) -> None:
    event_id = e["event_id"]
    if already_processed(conn, event_id):
        return

    typ = e["type"]
    account_id = e["aggregate_id"]
    agg_ver = int(e["aggregate_version"])
    occurred_at = e["occurred_at"]
    payload = json.loads(e["payload_json"])

    current = conn.execute("SELECT * FROM account_read WHERE account_id=?", (account_id,)).fetchone()
    owner = current["owner"] if current else None
    balance = float(current["balance"]) if current else 0.0
    version = int(current["version"]) if current else 0

    # Basic per-aggregate ordering safety
    if agg_ver <= version:
        mark_processed(conn, event_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        return

    if typ == "AccountOpened":
        owner = payload["owner"]
        summary = f"Account opened for {owner}"
    elif typ == "MoneyDeposited":
        amt = float(payload["amount"])
        balance += amt
        summary = f"Deposited ${amt:.2f}"
    elif typ == "MoneyWithdrawn":
        amt = float(payload["amount"])
        balance -= amt
        summary = f"Withdrew ${amt:.2f}"
    else:
        summary = f"Unknown event type {typ}"

    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    upsert_account(conn, account_id, owner, balance, agg_ver, updated_at)
    insert_timeline(conn, event_id, account_id, agg_ver, typ, occurred_at, summary)
    mark_processed(conn, event_id, updated_at)

def main():
    init_event_store_if_needed()
    init_read_model()
    print("Projector started. Tailing event store...")

    while True:
        try:
            es = connect(EVENT_DB)
            rm = connect(READ_DB)

            cursor = get_cursor(rm)
            rows = es.execute("SELECT * FROM events WHERE id > ? ORDER BY id ASC", (cursor,)).fetchall()

            if rows:
                rm.execute("BEGIN")
                last_row_id = cursor
                for r in rows:
                    apply_event(rm, r)
                    last_row_id = int(r["id"])
                set_cursor(rm, last_row_id)
                rm.commit()

            es.close()
            rm.close()
        except Exception as e:
            try:
                rm.rollback()
            except Exception:
                pass
            print("Projector error:", e)

        time.sleep(POLL_INTERVAL_MS / 1000.0)

if __name__ == "__main__":
    main()
