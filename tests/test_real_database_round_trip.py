"""Verify the bundle format against the real local database, if there is one.

This is the test that answers "will I lose my own history?". It reads
`app-data/flashcards.sqlite3`, exports it, restores into a throwaway
database, and compares every row. It skips on any machine without a local
database, so it never blocks CI.

It opens the real database read-only and writes only inside tmp_path.
"""

import shutil
import sqlite3
from pathlib import Path

import pytest

from backend.app.database import initialize_database
from backend.app.portable import build_bundle, read_manifest, restore_bundle

REPO = Path(__file__).resolve().parents[1]
REAL_DB = REPO / "app-data" / "flashcards.sqlite3"
REAL_ASSETS = REPO / "app-data" / "assets"

pytestmark = pytest.mark.skipif(not REAL_DB.is_file(), reason="no local app-data/flashcards.sqlite3")

TABLES = ("courses", "cards", "card_progress", "study_sessions", "review_events")


def rows(conn, table):
    return [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")]


@pytest.fixture(scope="module")
def real_conn():
    """Open the live database strictly read-only, so a bug here cannot write to it."""
    conn = sqlite3.connect(f"file:{REAL_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    yield conn
    conn.close()


def test_real_database_survives_an_export_and_restore(real_conn, tmp_path, monkeypatch):
    before = {table: rows(real_conn, table) for table in TABLES}
    assert before["review_events"], "expected real review history to verify against"

    bundle = build_bundle(real_conn, REAL_ASSETS)
    manifest = read_manifest(bundle)
    assert len(manifest["courses"]) == len(before["courses"])
    assert manifest["missing_assets"] == [], "every portrait on disk should be in the bundle"

    target = tmp_path / "restored"
    target.mkdir()
    assets = target / "assets"
    assets.mkdir()
    monkeypatch.setenv("FLASHCARDS_APP_DATA_DIR", str(target))
    initialize_database()
    restored_conn = sqlite3.connect(target / "flashcards.sqlite3")
    restored_conn.row_factory = sqlite3.Row
    counts = restore_bundle(bundle, restored_conn, assets)
    restored_conn.commit()

    assert counts["courses"] == len(before["courses"])
    assert counts["cards"] == len(before["cards"])
    assert counts["sessions"] == len(before["study_sessions"])
    assert counts["reviews"] == len(before["review_events"])

    after = {table: rows(restored_conn, table) for table in TABLES}
    # Compare the fields the bundle carries rather than the raw row shape: a
    # local database may still predate a schema change that the restore target,
    # created fresh, already has.
    def course_fields(table):
        keep = ("id", "title", "source_filename", "imported_at", "active")
        return [{field: row[field] for field in keep} for row in table]

    assert course_fields(after["courses"]) == course_fields(before["courses"])
    assert after["cards"] == before["cards"]
    assert after["study_sessions"] == before["study_sessions"]

    # review_events.id is an autoincrement surrogate that restore reassigns, and
    # it is never exposed through the API. Compare the rows by their natural key
    # instead, which is what actually has to survive a restore.
    def natural(table):
        return sorted(
            ({key: value for key, value in row.items() if key != "id"} for row in table),
            key=lambda row: (row["session_id"], row["reviewed_at"], row["card_id"], row["result"]),
        )

    assert natural(after["review_events"]) == natural(before["review_events"])

    for was, now in zip(before["card_progress"], after["card_progress"]):
        for field in ("card_id", "seen_count", "right_count", "wrong_count", "mastery", "stability_days", "last_reviewed_at", "last_result"):
            assert now[field] == was[field], f"{field} changed for {was['card_id']}"

    exported_portraits = sorted(path.relative_to(assets).as_posix() for path in assets.rglob("*.jpg"))
    original_portraits = sorted(path.relative_to(REAL_ASSETS).as_posix() for path in REAL_ASSETS.rglob("*.jpg"))
    assert exported_portraits == original_portraits
    for name in exported_portraits:
        assert (assets / name).read_bytes() == (REAL_ASSETS / name).read_bytes()

    restored_conn.close()


def test_the_restore_cli_rebuilds_the_real_database(tmp_path):
    """Exercise the documented disaster-recovery command end to end."""
    import subprocess

    source = tmp_path / "source"
    source.mkdir()
    shutil.copy(REAL_DB, source / "flashcards.sqlite3")
    shutil.copytree(REAL_ASSETS, source / "assets")

    conn = sqlite3.connect(source / "flashcards.sqlite3")
    conn.row_factory = sqlite3.Row
    bundle_path = tmp_path / "backup.zip"
    bundle_path.write_bytes(build_bundle(conn, source / "assets"))
    expected_reviews = conn.execute("SELECT COUNT(*) FROM review_events").fetchone()[0]
    conn.close()

    target = tmp_path / "rebuilt" / "flashcards.sqlite3"
    result = subprocess.run(
        [str(REPO / ".venv" / "bin" / "python"), str(REPO / "tools" / "restore_bundle.py"), str(bundle_path), "--into", str(target)],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    assert result.returncode == 0, result.stderr
    assert target.is_file()

    rebuilt = sqlite3.connect(target)
    assert rebuilt.execute("SELECT COUNT(*) FROM review_events").fetchone()[0] == expected_reviews
    assert rebuilt.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    rebuilt.close()


def test_the_cli_refuses_to_overwrite_an_existing_database(tmp_path):
    import subprocess

    conn = sqlite3.connect(f"file:{REAL_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    bundle_path = tmp_path / "backup.zip"
    bundle_path.write_bytes(build_bundle(conn, REAL_ASSETS))
    conn.close()

    occupied = tmp_path / "already-here.sqlite3"
    occupied.write_bytes(b"do not clobber me")
    result = subprocess.run(
        [str(REPO / ".venv" / "bin" / "python"), str(REPO / "tools" / "restore_bundle.py"), str(bundle_path), "--into", str(occupied)],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    assert result.returncode != 0
    assert "already exists" in result.stderr
    assert occupied.read_bytes() == b"do not clobber me"
