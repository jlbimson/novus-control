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

CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    setpoint REAL NOT NULL,
    duration_hours REAL NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS active_run (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    preset_id INTEGER,
    preset_name TEXT NOT NULL,
    setpoint REAL NOT NULL,
    duration_hours REAL NOT NULL,
    started_at REAL NOT NULL
);
"""

_PRESET_COLUMNS = ["id", "name", "folder", "setpoint", "duration_hours", "created_at", "updated_at"]
_ACTIVE_RUN_COLUMNS = ["preset_id", "preset_name", "setpoint", "duration_hours", "started_at"]


def _connect():
    conn = sqlite3.connect(config.DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)
        cols = {row[1] for row in conn.execute("PRAGMA table_info(presets)")}
        if "folder" not in cols:
            conn.execute("ALTER TABLE presets ADD COLUMN folder TEXT")
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


def list_presets():
    conn = _connect()
    try:
        cur = conn.execute(f"SELECT {', '.join(_PRESET_COLUMNS)} FROM presets ORDER BY name")
        return [dict(zip(_PRESET_COLUMNS, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def get_preset(preset_id: int):
    conn = _connect()
    try:
        cur = conn.execute(
            f"SELECT {', '.join(_PRESET_COLUMNS)} FROM presets WHERE id = ?", (preset_id,)
        )
        row = cur.fetchone()
        return dict(zip(_PRESET_COLUMNS, row)) if row else None
    finally:
        conn.close()


def create_preset(name: str, folder: str | None, setpoint: float, duration_hours: float) -> int:
    now = time.time()
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO presets (name, folder, setpoint, duration_hours, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, folder, setpoint, duration_hours, now, now),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_preset(preset_id: int, name: str, folder: str | None, setpoint: float, duration_hours: float):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE presets SET name = ?, folder = ?, setpoint = ?, duration_hours = ?, updated_at = ? "
            "WHERE id = ?",
            (name, folder, setpoint, duration_hours, time.time(), preset_id),
        )
        conn.commit()
    finally:
        conn.close()


def delete_preset(preset_id: int):
    conn = _connect()
    try:
        conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))
        conn.commit()
    finally:
        conn.close()


def get_active_run():
    conn = _connect()
    try:
        cur = conn.execute(
            f"SELECT {', '.join(_ACTIVE_RUN_COLUMNS)} FROM active_run WHERE id = 1"
        )
        row = cur.fetchone()
        return dict(zip(_ACTIVE_RUN_COLUMNS, row)) if row else None
    finally:
        conn.close()


def set_active_run(preset_id, preset_name: str, setpoint: float, duration_hours: float, started_at: float):
    conn = _connect()
    try:
        conn.execute("DELETE FROM active_run")
        conn.execute(
            "INSERT INTO active_run (id, preset_id, preset_name, setpoint, duration_hours, started_at) "
            "VALUES (1, ?, ?, ?, ?, ?)",
            (preset_id, preset_name, setpoint, duration_hours, started_at),
        )
        conn.commit()
    finally:
        conn.close()


def clear_active_run():
    conn = _connect()
    try:
        conn.execute("DELETE FROM active_run")
        conn.commit()
    finally:
        conn.close()
