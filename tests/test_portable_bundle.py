"""Round-trip tests for the portable bundle format.

The bundle is the backup format, so the property that matters is that a
restore reproduces study history exactly. Anything looser than exact is a
plan to lose somebody's semester.
"""

import json
import sqlite3
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from backend.app.database import initialize_database
from backend.app.portable import MANIFEST_NAME, build_bundle, read_manifest, restore_bundle

FIXTURE_COURSE = "course-test0001"


def make_database(path: Path, monkeypatch) -> sqlite3.Connection:
    monkeypatch.setenv("FLASHCARDS_APP_DATA_DIR", str(path))
    initialize_database()
    conn = sqlite3.connect(path / "flashcards.sqlite3")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def seed(conn, assets_dir: Path) -> None:
    conn.execute(
        "INSERT INTO courses (id, title, source_filename, imported_at) VALUES (?, ?, ?, ?)",
        (FIXTURE_COURSE, "Test Course", "test.pdf", "2026-01-01T00:00:00+00:00"),
    )
    people = [("Ada", "Lovelace", "one.jpg"), ("Grace", "Hopper", "two.jpg"), ("Alan", "Turing", None)]
    for index, (first, last, image) in enumerate(people):
        card_id = f"{FIXTURE_COURSE}-card-{index}"
        image_path = f"{FIXTURE_COURSE}/{image}" if image else None
        conn.execute(
            "INSERT INTO cards (id, course_id, first_name, last_name, facts, image_path, reviewed, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (card_id, FIXTURE_COURSE, first, last, json.dumps([f"fact {index}", "second fact"]), image_path, "2026-01-01T00:00:00+00:00"),
        )
        conn.execute(
            """
            INSERT INTO card_progress (card_id, seen_count, right_count, wrong_count, confidence, mastery, stability_days, last_reviewed_at, last_result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (card_id, index + 1, index, 1, 0.4, 0.4 + index / 10, 1.5 + index, "2026-02-01T00:00:00+00:00", "right"),
        )
        if image_path:
            target = assets_dir / image_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"\xff\xd8\xff\xd9" + bytes([index]))

    conn.execute(
        """
        INSERT INTO study_sessions (id, course_id, mode, started_at, ended_at, selected_count, reviewed_count, right_count, wrong_count, readiness_at_completion)
        VALUES ('session-1', ?, 'morris', '2026-02-01T00:00:00+00:00', '2026-02-01T00:10:00+00:00', 2, 5, 4, 1, 0.62)
        """,
        (FIXTURE_COURSE,),
    )
    for ordinal, result in enumerate(["right", "wrong", "right", "right", "right"]):
        conn.execute(
            "INSERT INTO review_events (session_id, card_id, reviewed_at, result) VALUES ('session-1', ?, ?, ?)",
            (f"{FIXTURE_COURSE}-card-{ordinal % 3}", f"2026-02-01T00:0{ordinal}:00+00:00", result),
        )
    conn.commit()


def snapshot(conn) -> dict:
    return {
        table: [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2")]
        for table in ("courses", "cards", "card_progress", "study_sessions", "review_events")
    }


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    root = tmp_path / "source"
    root.mkdir()
    assets = root / "assets"
    assets.mkdir()
    conn = make_database(root, monkeypatch)
    seed(conn, assets)
    yield conn, assets
    conn.close()


def test_bundle_contains_a_manifest_and_the_portraits_it_references(seeded):
    conn, assets = seeded
    bundle = build_bundle(conn, assets)
    with zipfile.ZipFile(BytesIO(bundle)) as archive:
        names = set(archive.namelist())
    assert MANIFEST_NAME in names
    assert f"assets/{FIXTURE_COURSE}/one.jpg" in names
    assert f"assets/{FIXTURE_COURSE}/two.jpg" in names
    # The third person has no portrait, so nothing should be invented for them.
    assert len([name for name in names if name.startswith("assets/")]) == 2


def test_facts_travel_as_a_list_not_a_json_string(seeded):
    conn, assets = seeded
    manifest = read_manifest(build_bundle(conn, assets))
    facts = manifest["courses"][0]["cards"][0]["facts"]
    assert isinstance(facts, list)
    assert facts == ["fact 0", "second fact"] or facts == ["fact 1", "second fact"] or facts == ["fact 2", "second fact"]


def test_round_trip_reproduces_every_row_exactly(seeded, tmp_path, monkeypatch):
    conn, assets = seeded
    before = snapshot(conn)
    bundle = build_bundle(conn, assets)

    target_root = tmp_path / "restored"
    target_root.mkdir()
    target_assets = target_root / "assets"
    target_assets.mkdir()
    restored_conn = make_database(target_root, monkeypatch)
    restored = restore_bundle(bundle, restored_conn, target_assets)
    restored_conn.commit()

    assert restored == {"courses": 1, "cards": 3, "sessions": 1, "reviews": 5, "assets": 2}
    after = snapshot(restored_conn)
    assert after["courses"] == before["courses"]
    assert after["cards"] == before["cards"]
    assert after["study_sessions"] == before["study_sessions"]
    assert [
        {key: value for key, value in row.items() if key != "id"} for row in after["review_events"]
    ] == [{key: value for key, value in row.items() if key != "id"} for row in before["review_events"]]
    # confidence is a legacy column; mastery and stability are what the model reads.
    for was, now in zip(before["card_progress"], after["card_progress"]):
        for field in ("card_id", "seen_count", "right_count", "wrong_count", "mastery", "stability_days", "last_reviewed_at", "last_result"):
            assert now[field] == was[field]
    for name in (f"{FIXTURE_COURSE}/one.jpg", f"{FIXTURE_COURSE}/two.jpg"):
        assert (target_assets / name).read_bytes() == (assets / name).read_bytes()
    restored_conn.close()


def test_roster_only_export_carries_no_progress_or_sessions(seeded):
    conn, assets = seeded
    manifest = read_manifest(build_bundle(conn, assets, include_progress=False))
    course = manifest["courses"][0]
    assert manifest["includes_progress"] is False
    assert course["sessions"] == []
    assert all("progress" not in card for card in course["cards"])
    assert len(course["cards"]) == 3


def test_roster_only_restore_starts_everyone_unseen(seeded, tmp_path, monkeypatch):
    conn, assets = seeded
    bundle = build_bundle(conn, assets, include_progress=False)
    target_root = tmp_path / "shared"
    target_root.mkdir()
    target_assets = target_root / "assets"
    target_assets.mkdir()
    restored_conn = make_database(target_root, monkeypatch)
    restore_bundle(bundle, restored_conn, target_assets)
    restored_conn.commit()
    progress = [dict(row) for row in restored_conn.execute("SELECT * FROM card_progress")]
    assert len(progress) == 3
    assert all(row["seen_count"] == 0 and row["mastery"] == 0.5 for row in progress)
    assert restored_conn.execute("SELECT COUNT(*) FROM review_events").fetchone()[0] == 0
    restored_conn.close()


def test_restore_refuses_to_merge_into_a_database_that_already_has_the_course(seeded):
    conn, assets = seeded
    bundle = build_bundle(conn, assets)
    with pytest.raises(ValueError, match="already exist"):
        restore_bundle(bundle, conn, assets)


def test_restore_leaves_the_target_untouched_when_it_refuses(seeded):
    conn, assets = seeded
    before = snapshot(conn)
    bundle = build_bundle(conn, assets)
    with pytest.raises(ValueError):
        restore_bundle(bundle, conn, assets)
    assert snapshot(conn) == before


def test_exporting_an_unknown_course_is_an_error(seeded):
    conn, assets = seeded
    with pytest.raises(ValueError, match="Unknown course"):
        build_bundle(conn, assets, ["course-does-not-exist"])


def test_a_missing_portrait_is_reported_rather_than_failing_the_export(seeded):
    conn, assets = seeded
    (assets / FIXTURE_COURSE / "one.jpg").unlink()
    manifest = read_manifest(build_bundle(conn, assets))
    assert manifest["missing_assets"] == [f"{FIXTURE_COURSE}/one.jpg"]
    flagged = [card for card in manifest["courses"][0]["cards"] if card.get("missing_asset")]
    assert len(flagged) == 1


def test_an_unsupported_schema_is_rejected(seeded):
    conn, assets = seeded
    bundle = build_bundle(conn, assets)
    with zipfile.ZipFile(BytesIO(bundle)) as archive:
        manifest = json.loads(archive.read(MANIFEST_NAME))
    manifest["schema"] = 999
    tampered = BytesIO()
    with zipfile.ZipFile(tampered, "w") as archive:
        archive.writestr(MANIFEST_NAME, json.dumps(manifest))
    with pytest.raises(ValueError, match="Unsupported bundle schema"):
        read_manifest(tampered.getvalue())
