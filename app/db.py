import sqlite3
import time

import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_key_ts ON readings(key, ts);
"""


def _connect():
    conn = sqlite3.connect(config.DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def insert_readings(values: dict):
    """values: {key: numeric_value}"""
    if not values:
        return
    now = time.time()
    conn = _connect()
    try:
        conn.executemany(
            "INSERT INTO readings (ts, key, value) VALUES (?, ?, ?)",
            [(now, key, value) for key, value in values.items()],
        )
        conn.commit()
    finally:
        conn.close()


def history(key: str, since_ts: float):
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT ts, value FROM readings WHERE key = ? AND ts >= ? ORDER BY ts",
            (key, since_ts),
        )
        return [{"ts": row[0], "value": row[1]} for row in cur.fetchall()]
    finally:
        conn.close()
