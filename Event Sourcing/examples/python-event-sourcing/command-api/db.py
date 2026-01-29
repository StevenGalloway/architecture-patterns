import os
import sqlite3

def db_path(data_dir: str, name: str) -> str:
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, name)

def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn
