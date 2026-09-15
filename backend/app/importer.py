"""Storing the people a roster yielded.

Extraction used to happen here, with poppler and tesseract. It now happens in
the browser for every build, so this module no longer opens a PDF at all: it
receives people who have already been read out of one and decides which of them
are new to the course.

Moving extraction to the client was not a concession to the hosted build. On a
real 23-page scanned export it is about seven times faster — pdf.js rasterises
straight to a canvas, where the native path shelled out to `pdftoppm` to write
every page as a temporary PNG first — and it means the roster PDF never leaves
the machine it was chosen on, even when a server is involved. One extractor also
means the layout rules cannot drift into two different ideas of who is in a
class.
"""

import uuid
from datetime import datetime, timezone


def store_people(
    conn,
    course_id: str,
    people: list[dict],
    *,
    source_filename: str,
    source_checksum: str,
    pages: int,
    title: str | None = None,
    create_course: bool = False,
) -> dict:
    """Fold extracted people into a course the caller chose.

    New people arrive unreviewed, so they go through the same approval step as
    the very first import. People already present keep their study history
    untouched and gain a portrait only if they had none: replacing one somebody
    is already learning from would change a face out from under them.

    Matching is exact on first and last name, mirroring `core/src/import.ts`. A
    fuzzy match would silently merge two people's histories, which cannot be
    undone, while an extra candidate costs one click during review.
    """
    now = datetime.now(timezone.utc).isoformat()
    run = conn.execute(
        "INSERT INTO import_runs (source_filename, source_checksum, started_at, status) VALUES (?, ?, ?, 'running')",
        (source_filename, source_checksum, now),
    )
    try:
        if create_course:
            conn.execute(
                "INSERT INTO courses (id, title, source_filename, imported_at) VALUES (?, ?, ?, ?)",
                (course_id, title or source_filename.rsplit(".", 1)[0].replace("_", " "), source_filename, now),
            )
        elif not conn.execute("SELECT 1 FROM courses WHERE id = ?", (course_id,)).fetchone():
            raise ValueError("That course no longer exists.")

        existing = {
            (row["first_name"].strip(), row["last_name"].strip()): (row["id"], row["image_path"])
            for row in conn.execute(
                "SELECT id, first_name, last_name, image_path FROM cards WHERE course_id = ?", (course_id,)
            )
        }
        added = 0
        already_present = 0

        for person in people:
            key = (person["first_name"].strip(), person["last_name"].strip())
            portrait = person.get("image_path")

            if key in existing:
                already_present += 1
                card_id, current_portrait = existing[key]
                if portrait and not current_portrait:
                    conn.execute("UPDATE cards SET image_path = ? WHERE id = ?", (portrait, card_id))
                    existing[key] = (card_id, portrait)
                continue

            card_id = f"{course_id}-card-{uuid.uuid4().hex[:8]}"
            conn.execute(
                "INSERT INTO cards (id, course_id, first_name, last_name, image_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (card_id, course_id, person["first_name"], person["last_name"], portrait, now),
            )
            conn.execute("INSERT INTO card_progress (card_id) VALUES (?)", (card_id,))
            existing[key] = (card_id, portrait)
            added += 1

        warning = None
        if not people:
            warning = "No names were read from that roster. Add people manually, or check that this is a 3-students-per-page BYU Flashcards export."
        elif not added:
            warning = "Everybody in this roster is already in the course, so nothing was added."

        conn.execute(
            "UPDATE import_runs SET finished_at = ?, status = 'complete', pages = ?, candidate_count = ?, warning = ? WHERE id = ?",
            (now, pages, len(people), warning, run.lastrowid),
        )
        return {
            "status": "created" if create_course else "updated",
            "course_id": course_id,
            "pages": pages,
            "found": len(people),
            "added": added,
            "already_present": already_present,
            "warning": warning,
        }
    except Exception as exc:
        conn.execute(
            "UPDATE import_runs SET finished_at = ?, status = 'failed', warning = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), str(exc), run.lastrowid),
        )
        raise
