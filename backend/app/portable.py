"""A portable, self-describing course bundle.

This is the format that lets study history outlive any one storage engine:
a zip holding one JSON document plus the portrait files it references. It is
the local backup format, the migration path into browser storage, and the
only supported way to hand a roster to someone else.

Deliberate properties:

* JSON, not a SQLite dump, so a browser build can read it without a SQL engine.
* `facts` travels as a real list rather than the JSON-in-TEXT column the
  database happens to use.
* Progress is optional, so a roster can be shared without sharing how well
  somebody knows it.
* Restore never edits rows in place. It writes whole courses or refuses.
"""

import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

BUNDLE_SCHEMA = 1
MANIFEST_NAME = "familiar-bundle.json"

COURSE_FIELDS = ("id", "title", "source_filename", "source_checksum", "imported_at", "active")
CARD_FIELDS = ("id", "first_name", "last_name", "prompt_text", "image_path", "reviewed", "created_at")
PROGRESS_FIELDS = (
    "seen_count",
    "right_count",
    "wrong_count",
    "mastery",
    "stability_days",
    "last_reviewed_at",
    "last_result",
)
SESSION_FIELDS = (
    "id",
    "mode",
    "started_at",
    "ended_at",
    "selected_count",
    "reviewed_count",
    "right_count",
    "wrong_count",
    "readiness_at_completion",
)

FRESH_PROGRESS = {
    "seen_count": 0,
    "right_count": 0,
    "wrong_count": 0,
    "mastery": 0.5,
    "stability_days": 0.25,
    "last_reviewed_at": None,
    "last_result": None,
}


def _pick(row, fields) -> dict:
    return {field: row[field] for field in fields}


def build_manifest(conn, course_ids: list[str] | None = None, include_progress: bool = True) -> dict:
    """Collect courses, cards, progress and session history into plain data."""
    if course_ids is None:
        rows = conn.execute("SELECT * FROM courses ORDER BY imported_at").fetchall()
    else:
        placeholders = ",".join("?" for _ in course_ids)
        rows = conn.execute(
            f"SELECT * FROM courses WHERE id IN ({placeholders}) ORDER BY imported_at", tuple(course_ids)
        ).fetchall()
        found = {row["id"] for row in rows}
        missing = [course_id for course_id in course_ids if course_id not in found]
        if missing:
            raise ValueError(f"Unknown course: {', '.join(missing)}")

    courses = []
    for course in rows:
        card_rows = conn.execute(
            """
            SELECT cards.*, progress.seen_count, progress.right_count, progress.wrong_count,
                   progress.mastery, progress.stability_days, progress.last_reviewed_at, progress.last_result
            FROM cards LEFT JOIN card_progress progress ON progress.card_id = cards.id
            WHERE cards.course_id = ?
            ORDER BY cards.last_name, cards.first_name
            """,
            (course["id"],),
        ).fetchall()
        cards = []
        for row in card_rows:
            card = _pick(row, CARD_FIELDS)
            card["facts"] = json.loads(row["facts"]) if row["facts"] else []
            if include_progress:
                # A card with no progress row is still exportable; it restores unseen.
                card["progress"] = (
                    dict(FRESH_PROGRESS) if row["seen_count"] is None else _pick(row, PROGRESS_FIELDS)
                )
            cards.append(card)

        sessions = []
        if include_progress:
            for session in conn.execute(
                "SELECT * FROM study_sessions WHERE course_id = ? ORDER BY started_at", (course["id"],)
            ).fetchall():
                entry = _pick(session, SESSION_FIELDS)
                entry["reviews"] = [
                    {"card_id": review["card_id"], "reviewed_at": review["reviewed_at"], "result": review["result"]}
                    for review in conn.execute(
                        "SELECT card_id, reviewed_at, result FROM review_events WHERE session_id = ? ORDER BY reviewed_at, id",
                        (session["id"],),
                    ).fetchall()
                ]
                sessions.append(entry)

        entry = _pick(course, COURSE_FIELDS)
        entry["cards"] = cards
        entry["sessions"] = sessions
        courses.append(entry)

    return {
        "schema": BUNDLE_SCHEMA,
        "app": "familiar",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "includes_progress": include_progress,
        "courses": courses,
    }


def build_bundle(conn, assets_dir: Path, course_ids: list[str] | None = None, include_progress: bool = True) -> bytes:
    """Serialise a manifest plus its portrait files into a zip archive."""
    manifest = build_manifest(conn, course_ids, include_progress)

    # Resolve portraits before writing anything, so the manifest can record what
    # was missing. A portrait absent from disk must not cost somebody their
    # review history, so this is reported in the bundle rather than raised.
    present: list[tuple[Path, str]] = []
    missing: list[str] = []
    for course in manifest["courses"]:
        for card in course["cards"]:
            image_path = card.get("image_path")
            if not image_path:
                continue
            source = assets_dir / image_path
            if source.is_file():
                present.append((source, f"assets/{image_path}"))
            else:
                card["missing_asset"] = True
                missing.append(image_path)
    manifest["missing_assets"] = sorted(missing)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))
        for source, name in present:
            archive.write(source, name)
    return buffer.getvalue()


def read_manifest(bundle: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        manifest = json.loads(archive.read(MANIFEST_NAME))
    if manifest.get("schema") != BUNDLE_SCHEMA:
        raise ValueError(f"Unsupported bundle schema: {manifest.get('schema')!r}")
    return manifest


def restore_bundle(bundle: bytes, conn, assets_dir: Path) -> dict:
    """Write every course in a bundle into a database that does not have them.

    Refuses rather than merges. Restoring is for rebuilding a lost database or
    loading a shared roster, not for reconciling two divergent histories, and a
    silent merge is how somebody loses review history.
    """
    manifest = read_manifest(bundle)
    course_ids = [course["id"] for course in manifest["courses"]]
    placeholders = ",".join("?" for _ in course_ids) or "NULL"
    clashes = [
        row["id"]
        for row in conn.execute(f"SELECT id FROM courses WHERE id IN ({placeholders})", tuple(course_ids))
    ]
    if clashes:
        raise ValueError(
            f"These courses already exist: {', '.join(clashes)}. "
            "Restore into a fresh database instead of merging into this one."
        )

    restored = {"courses": 0, "cards": 0, "sessions": 0, "reviews": 0, "assets": 0}
    for course in manifest["courses"]:
        conn.execute(
            "INSERT INTO courses (id, title, source_filename, source_checksum, imported_at, active) VALUES (?, ?, ?, ?, ?, ?)",
            tuple(course[field] for field in COURSE_FIELDS),
        )
        restored["courses"] += 1
        for card in course["cards"]:
            conn.execute(
                """
                INSERT INTO cards (id, course_id, first_name, last_name, facts, prompt_text, image_path, reviewed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card["id"],
                    course["id"],
                    card["first_name"],
                    card["last_name"],
                    # The importer leaves `facts` as the column default of '' while
                    # manually added cards store '[]'. Both read back as no facts;
                    # matching the default keeps a restore byte-identical to the
                    # database it came from.
                    json.dumps(card["facts"]) if card.get("facts") else "",
                    card.get("prompt_text") or "",
                    card.get("image_path"),
                    card.get("reviewed", 1),
                    card["created_at"],
                ),
            )
            progress = {**FRESH_PROGRESS, **(card.get("progress") or {})}
            conn.execute(
                """
                INSERT INTO card_progress
                  (card_id, seen_count, right_count, wrong_count, confidence, mastery, stability_days, last_reviewed_at, last_result)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    card["id"],
                    progress["seen_count"],
                    progress["right_count"],
                    progress["wrong_count"],
                    progress["mastery"],
                    progress["mastery"],
                    progress["stability_days"],
                    progress["last_reviewed_at"],
                    progress["last_result"],
                ),
            )
            restored["cards"] += 1

        for session in course.get("sessions") or []:
            conn.execute(
                """
                INSERT INTO study_sessions
                  (id, course_id, mode, started_at, ended_at, selected_count, reviewed_count, right_count, wrong_count, readiness_at_completion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session["id"],
                    course["id"],
                    session["mode"],
                    session["started_at"],
                    session.get("ended_at"),
                    session.get("selected_count", 0),
                    session.get("reviewed_count", 0),
                    session.get("right_count", 0),
                    session.get("wrong_count", 0),
                    session.get("readiness_at_completion"),
                ),
            )
            restored["sessions"] += 1
            for review in session.get("reviews") or []:
                conn.execute(
                    "INSERT INTO review_events (session_id, card_id, reviewed_at, result) VALUES (?, ?, ?, ?)",
                    (session["id"], review["card_id"], review["reviewed_at"], review["result"]),
                )
                restored["reviews"] += 1

    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        for name in archive.namelist():
            if not name.startswith("assets/") or name.endswith("/"):
                continue
            target = assets_dir / name[len("assets/") :]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
            restored["assets"] += 1

    return restored
