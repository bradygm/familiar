import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def app_data_dir() -> Path:
    path = Path(os.environ.get("FLASHCARDS_APP_DATA_DIR", "app-data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def database_path() -> Path:
    return app_data_dir() / "flashcards.sqlite3"


@contextmanager
def connection():
    conn = sqlite3.connect(database_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialize_database() -> None:
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS courses (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              source_filename TEXT NOT NULL,
              source_checksum TEXT NOT NULL UNIQUE,
              imported_at TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS import_runs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_filename TEXT NOT NULL,
              source_checksum TEXT NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT,
              status TEXT NOT NULL,
              pages INTEGER,
              extracted_text_length INTEGER,
              candidate_count INTEGER NOT NULL DEFAULT 0,
              warning TEXT
            );

            CREATE TABLE IF NOT EXISTS cards (
              id TEXT PRIMARY KEY,
              course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
              first_name TEXT NOT NULL,
              last_name TEXT NOT NULL,
              facts TEXT NOT NULL DEFAULT '',
              prompt_text TEXT NOT NULL DEFAULT '',
              image_path TEXT,
              reviewed INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS card_progress (
              card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
              seen_count INTEGER NOT NULL DEFAULT 0,
              right_count INTEGER NOT NULL DEFAULT 0,
              wrong_count INTEGER NOT NULL DEFAULT 0,
              confidence REAL NOT NULL DEFAULT 0,
              last_reviewed_at TEXT,
              last_result TEXT
            );

            CREATE TABLE IF NOT EXISTS study_sessions (
              id TEXT PRIMARY KEY,
              course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
              mode TEXT NOT NULL,
              started_at TEXT NOT NULL,
              ended_at TEXT,
              selected_count INTEGER NOT NULL,
              reviewed_count INTEGER NOT NULL DEFAULT 0,
              right_count INTEGER NOT NULL DEFAULT 0,
              wrong_count INTEGER NOT NULL DEFAULT 0,
              readiness_at_completion REAL
            );

            CREATE TABLE IF NOT EXISTS review_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
              card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              reviewed_at TEXT NOT NULL,
              result TEXT NOT NULL CHECK(result IN ('right', 'wrong'))
            );
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(card_progress)")}
        if "mastery" not in columns:
            conn.execute("ALTER TABLE card_progress ADD COLUMN mastery REAL NOT NULL DEFAULT 0.5")
            conn.execute("ALTER TABLE card_progress ADD COLUMN stability_days REAL NOT NULL DEFAULT 0.25")
            conn.execute(
                """
                UPDATE card_progress
                SET mastery = (right_count + 2.0) / (seen_count + 4.0),
                    stability_days = CASE
                      WHEN seen_count = 0 THEN 0.04
                      WHEN right_count > wrong_count THEN 1.0
                      ELSE 0.18
                    END
                """
            )
        session_columns = {row["name"] for row in conn.execute("PRAGMA table_info(study_sessions)")}
        if "readiness_at_completion" not in session_columns:
            conn.execute("ALTER TABLE study_sessions ADD COLUMN readiness_at_completion REAL")

    _drop_course_checksum()


def _drop_course_checksum() -> None:
    """Remove courses.source_checksum, which encoded "one course per PDF file".

    Imports now target a course the user picked, so a course is no longer
    identified by the file that created it: a class can be built from several
    exports, and the same export can seed more than one class. The column's
    UNIQUE constraint actively prevents both. Per-import provenance is kept in
    import_runs, which is the honest place for it now that one course can have
    many sources.

    SQLite cannot drop a UNIQUE column, so this rebuilds the table. Foreign keys
    are disabled for the duration: cards reference courses ON DELETE CASCADE, and
    dropping the old table with them enforced would take every card with it.
    """
    connection_path = database_path()
    conn = sqlite3.connect(connection_path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(courses)")}
        if "source_checksum" not in columns:
            return

        # Must be set outside a transaction to take effect.
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE courses_rebuilt (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              source_filename TEXT NOT NULL,
              imported_at TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        conn.execute(
            "INSERT INTO courses_rebuilt (id, title, source_filename, imported_at, active) "
            "SELECT id, title, source_filename, imported_at, active FROM courses"
        )
        moved = conn.execute("SELECT COUNT(*) FROM courses_rebuilt").fetchone()[0]
        original = conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0]
        if moved != original:
            raise RuntimeError(f"Course rebuild would lose rows: {original} -> {moved}")

        conn.execute("DROP TABLE courses")
        conn.execute("ALTER TABLE courses_rebuilt RENAME TO courses")

        # Prove nothing was orphaned before making it permanent.
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(f"Course rebuild broke referential integrity: {violations[:3]}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()
