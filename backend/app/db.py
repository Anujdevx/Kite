"""SQLite storage. Plain stdlib sqlite3; one short-lived connection per operation."""
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,          -- 'user' or 'assistant'
    content TEXT NOT NULL,
    metadata TEXT,               -- JSON string, assistant messages only
    created_at TEXT NOT NULL     -- server time, ISO-8601
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id);
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    system_prompt TEXT,
    created_at TEXT NOT NULL
);
"""


def db_path() -> str:
    # DATABASE_URL looks like sqlite:////data/app.db (absolute) or sqlite:///./app.db (relative)
    url = os.getenv("DATABASE_URL", "sqlite:///./app.db")
    return url.removeprefix("sqlite:///")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    path = db_path()
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with closing(connect()) as conn, conn:
        conn.executescript(SCHEMA)


def ping() -> None:
    with closing(connect()) as conn, conn:
        conn.execute("SELECT 1")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_session(session_id: str):
    """Returns (system_prompt, [{"role", "content"}...]) or None for an unknown session."""
    with closing(connect()) as conn, conn:
        sess = conn.execute("SELECT system_prompt FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if sess is None:
            return None
        rows = conn.execute(
            "SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY id", (session_id,)
        ).fetchall()
    return sess["system_prompt"], [dict(r) for r in rows]


def save_turn(session_id: str, system_prompt: str | None, user_msg: str, reply: str, metadata: dict) -> None:
    """User message + assistant reply in ONE transaction, only after the LLM succeeded,
    so a failed request (422/503) never leaves a half turn in history."""
    ts = now()
    with closing(connect()) as conn, conn:  # the `with` block commits, or rolls back on error
        conn.execute(
            "INSERT INTO sessions (session_id, system_prompt, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(session_id) DO UPDATE SET system_prompt = excluded.system_prompt",
            (session_id, system_prompt, ts),
        )
        conn.execute(
            "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, 'user', ?, NULL, ?)",
            (session_id, user_msg, ts),
        )
        conn.execute(
            "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, 'assistant', ?, ?, ?)",
            (session_id, reply, json.dumps(metadata), ts),
        )
