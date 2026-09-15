import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .database import app_data_dir, connection, initialize_database
from .importer import store_people
from .portable import build_bundle, restore_bundle


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
ASSETS = app_data_dir() / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Local Flashcards")
app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")


@app.middleware("http")
async def disable_frontend_cache(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith(("/api/", "/assets/")):
        response.headers["Cache-Control"] = "no-store"
    return response


class StartSessionRequest(BaseModel):
    mode: str
    # The client selects the cards, using the shared core. The server records
    # which ones were chosen; it does not decide.
    card_ids: list[str] = Field(min_length=1, max_length=500)


class ReviewRequest(BaseModel):
    card_id: str
    result: str
    # Computed by the shared core in the client. Bounds are a sanity check on
    # the wire format, deliberately wider than the model's own clamps so they
    # do not have to be kept in step with its coefficients.
    mastery: float = Field(ge=0.0, le=1.0)
    stability_days: float = Field(gt=0.0, le=400.0)
    # The instant the client used when computing the values above. Stored so the
    # state is exactly reproducible from its own inputs; without it the recorded
    # timestamp is the server's and disagrees with the computation by the
    # round-trip time.
    reviewed_at: str | None = None


class ResetCourseRequest(BaseModel):
    """Resetting destroys review history, so the caller must name what it is destroying."""

    confirm_title: str


class CompleteSessionRequest(BaseModel):
    """Readiness is the course average at completion, computed by the client."""

    readiness: float | None = Field(default=None, ge=0.0, le=1.0)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# How far a client clock may differ from the server's before it is distrusted.
CLIENT_CLOCK_TOLERANCE_SECONDS = 300


def _client_timestamp(value: str | None) -> str:
    """Prefer the client's instant, falling back to the server's if implausible.

    The client computes the memory update against its own clock, so storing that
    same instant keeps the saved state reproducible. A badly set clock would
    otherwise write timestamps that distort every later recall prediction, so
    anything far from the server's own time is discarded rather than trusted.
    """
    server_now = datetime.now(timezone.utc)
    if not value:
        return server_now.isoformat()
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return server_now.isoformat()
    if parsed.tzinfo is None:
        return server_now.isoformat()
    if abs((server_now - parsed).total_seconds()) > CLIENT_CLOCK_TOLERANCE_SECONDS:
        return server_now.isoformat()
    return parsed.isoformat()


def card_row(row) -> dict:
    item = dict(row)
    item["facts"] = json.loads(item["facts"]) if item["facts"] else []
    return item


CORE_BUNDLE = FRONTEND / "vendor" / "core" / "index.js"


@app.on_event("startup")
def startup() -> None:
    # The learning model is TypeScript compiled into frontend/vendor/, which is
    # generated rather than committed. Without it the page loads and then dies
    # on a missing module, so say so here instead.
    if not CORE_BUNDLE.is_file():
        raise RuntimeError(
            f"The shared learning core is not built ({CORE_BUNDLE} is missing).\n"
            "Docker builds it automatically: docker compose up --build\n"
            "Running natively: cd core && npm install && npm run build"
        )
    initialize_database()


@app.get("/api/health")
def health():
    return {"status": "ok"}

# Portraits, not a PDF: extraction happens in the browser, so what arrives here
# is already the finished crops.
MAX_UPLOAD_BYTES = 250 * 1024 * 1024


def _store_portraits(course_id: str, contents: list[bytes]) -> list[str]:
    """Write portrait crops under names unrelated to where they came from.

    A name derived from page and position is only unique within one roster, so a
    later import would overwrite an earlier person's face. These cannot collide.
    """
    directory = ASSETS / course_id
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for blob in contents:
        filename = f"person-{uuid.uuid4().hex[:12]}.jpg"
        (directory / filename).write_bytes(blob)
        paths.append(f"{course_id}/{filename}")
    return paths


async def _receive_roster(
    course_id: str,
    people_json: str,
    source_filename: str,
    source_checksum: str,
    pages: int,
    portraits: list[UploadFile],
    title: str | None,
    create_course: bool,
) -> dict:
    """Record people the client extracted, with the portraits it cut out.

    The PDF itself never arrives: it is read in the browser, which is faster than
    the native path was and keeps a file of student photographs on the machine it
    was chosen on.
    """
    try:
        people = json.loads(people_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Malformed roster data.") from exc
    if not isinstance(people, list):
        raise HTTPException(status_code=400, detail="Malformed roster data.")
    for person in people:
        if not isinstance(person, dict) or not str(person.get("first_name", "")).strip() or not str(person.get("last_name", "")).strip():
            raise HTTPException(status_code=400, detail="Every person needs a first and last name.")

    contents = []
    total = 0
    for upload in portraits:
        blob = await upload.read()
        total += len(blob)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Those portraits are larger than this build accepts.")
        contents.append(blob)

    stored = _store_portraits(course_id, contents)
    for person in people:
        index = person.pop("portrait", None)
        person["image_path"] = stored[index] if isinstance(index, int) and 0 <= index < len(stored) else None

    with connection() as conn:
        try:
            return store_people(
                conn,
                course_id,
                people,
                source_filename=source_filename,
                source_checksum=source_checksum,
                pages=pages,
                title=title,
                create_course=create_course,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/courses")
async def create_course(
    people: str = Form(...),
    source_filename: str = Form(...),
    source_checksum: str = Form(""),
    pages: int = Form(0),
    title: str | None = Form(default=None),
    portraits: list[UploadFile] = File(default=[]),
):
    """Start a class from a roster the browser has already read."""
    course_id = f"course-{uuid.uuid4().hex[:12]}"
    return await _receive_roster(
        course_id, people, source_filename, source_checksum, pages, portraits, (title or "").strip() or None, True
    )


@app.post("/api/courses/{course_id}/imports")
async def import_into_course(
    course_id: str,
    people: str = Form(...),
    source_filename: str = Form(...),
    source_checksum: str = Form(""),
    pages: int = Form(0),
    portraits: list[UploadFile] = File(default=[]),
):
    """Add people to an existing class from another roster."""
    return await _receive_roster(course_id, people, source_filename, source_checksum, pages, portraits, None, False)



@app.get("/api/courses")
def courses():
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT c.*, COUNT(cards.id) AS card_count,
                   (SELECT MAX(s.ended_at) FROM study_sessions s WHERE s.course_id = c.id) AS last_studied_at,
                   (SELECT COUNT(*) FROM study_sessions s WHERE s.course_id = c.id) AS session_count,
                   (SELECT COUNT(*) FROM review_events r JOIN study_sessions s ON s.id = r.session_id WHERE s.course_id = c.id) AS review_count,
                   (SELECT COUNT(*) FROM review_events r JOIN study_sessions s ON s.id = r.session_id WHERE s.course_id = c.id AND r.result = 'right') AS right_count
            FROM courses c
            LEFT JOIN cards ON cards.course_id = c.id AND cards.reviewed = 1
            WHERE c.active = 1
            GROUP BY c.id
            ORDER BY c.imported_at DESC
            """
        ).fetchall()
        items = [dict(row) for row in rows]
        for item in items:
            # Raw progress, summarised by the client through the shared core.
            item["progress"] = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT progress.seen_count, progress.mastery, progress.stability_days, progress.last_reviewed_at
                    FROM card_progress AS progress
                    JOIN cards ON cards.id = progress.card_id
                    WHERE cards.course_id = ? AND cards.reviewed = 1
                    """,
                    (item["id"],),
                ).fetchall()
            ]
        return items


@app.get("/api/courses/{course_id}")
def course(course_id: str):
    with connection() as conn:
        item = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="Course not found")
        return dict(item)


@app.get("/api/courses/{course_id}/cards")
def cards(course_id: str, sort: str = "last"):
    sort_columns = {
        "first": "cards.first_name, cards.last_name",
        "last": "cards.last_name, cards.first_name",
    }
    column = sort_columns.get(sort, sort_columns["first"])
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT cards.*, progress.seen_count, progress.right_count, progress.wrong_count,
                   progress.mastery, progress.stability_days, progress.last_reviewed_at
            FROM cards JOIN card_progress progress ON progress.card_id = cards.id
            WHERE cards.course_id = ? AND cards.reviewed = 1
            ORDER BY {column}
            """,
            (course_id,),
        ).fetchall()
        # Ordering by predicted recall is a model question, so the client does it
        # with the shared core. Name ordering is plain SQL and stays here.
        return [card_row(row) for row in rows]


@app.get("/api/courses/{course_id}/candidates")
def candidates(course_id: str):
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM cards WHERE course_id = ? AND reviewed = 0 ORDER BY last_name, first_name",
            (course_id,),
        ).fetchall()
        return [card_row(row) for row in rows]


@app.get("/api/courses/{course_id}/stats")
def course_stats(course_id: str):
    with connection() as conn:
        course_exists = conn.execute("SELECT 1 FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not course_exists:
            raise HTTPException(status_code=404, detail="Course not found")
        totals = conn.execute(
            """
            SELECT COUNT(review_events.id) AS reviews,
                   COALESCE(SUM(CASE WHEN review_events.result = 'right' THEN 1 ELSE 0 END), 0) AS right_count,
                   COALESCE(SUM(CASE WHEN review_events.result = 'wrong' THEN 1 ELSE 0 END), 0) AS wrong_count,
                   COUNT(DISTINCT study_sessions.id) AS session_count
            FROM study_sessions
            LEFT JOIN review_events ON review_events.session_id = study_sessions.id
            WHERE study_sessions.course_id = ?
            """,
            (course_id,),
        ).fetchone()
        progress_rows = conn.execute(
            """
            SELECT seen_count, mastery, stability_days, last_reviewed_at
            FROM card_progress JOIN cards ON cards.id = card_progress.card_id
            WHERE cards.course_id = ? AND cards.reviewed = 1
            """,
            (course_id,),
        ).fetchall()
        trend_rows = conn.execute(
            """
            SELECT ended_at, readiness_at_completion
            FROM study_sessions
            WHERE course_id = ? AND ended_at IS NOT NULL AND reviewed_count > 0
                  AND readiness_at_completion IS NOT NULL
            ORDER BY ended_at DESC
            LIMIT 20
            """,
            (course_id,),
        ).fetchall()
        trend = [
            {
                "ended_at": row["ended_at"],
                "readiness": round(row["readiness_at_completion"] * 100),
            }
            for row in reversed(trend_rows)
        ]
        result = dict(totals)
        # Readiness, familiarity and the new/learning/familiar split are all model
        # questions; the client derives them from these rows via the shared core.
        result["progress"] = [dict(row) for row in progress_rows]
        result["readiness_trend"] = trend
        return result


@app.get("/api/courses/{course_id}/cards/{card_id}/history")
def card_history(course_id: str, card_id: str):
    with connection() as conn:
        card = conn.execute(
            "SELECT 1 FROM cards WHERE id = ? AND course_id = ? AND reviewed = 1",
            (card_id, course_id),
        ).fetchone()
        if not card:
            raise HTTPException(status_code=404, detail="Card not found")
        rows = conn.execute(
            "SELECT result, reviewed_at FROM review_events WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 12",
            (card_id,),
        ).fetchall()
        return {"events": [dict(row) for row in reversed(rows)]}


@app.post("/api/courses/{course_id}/cards")
async def create_card(
    course_id: str,
    first_name: str = Form(...),
    last_name: str = Form(...),
    facts: str = Form("[]"),
    portrait: UploadFile | None = File(default=None),
):
    """Add somebody the importer missed, optionally with a photo.

    Sent as multipart rather than JSON so a photo can travel as bytes. Everyone
    added this way is approved immediately: the learner typed the name, so there
    is nothing left to review.
    """
    if not first_name.strip() or not last_name.strip():
        raise HTTPException(status_code=400, detail="A first and last name are both needed.")
    try:
        parsed_facts = json.loads(facts)
        if not isinstance(parsed_facts, list):
            raise ValueError
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Malformed facts.") from exc

    with connection() as conn:
        if not conn.execute("SELECT 1 FROM courses WHERE id = ?", (course_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Course not found")

        image_path = None
        if portrait is not None and portrait.filename:
            blob = await portrait.read()
            if len(blob) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="That photo is too large.")
            if blob:
                image_path = _store_portraits(course_id, [blob])[0]

        card_id = f"{course_id}-card-{uuid.uuid4().hex[:8]}"
        conn.execute(
            "INSERT INTO cards (id, course_id, first_name, last_name, facts, image_path, reviewed, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (card_id, course_id, first_name.strip(), last_name.strip(), json.dumps(parsed_facts), image_path, now()),
        )
        conn.execute("INSERT INTO card_progress (card_id) VALUES (?)", (card_id,))
        return {"id": card_id}


@app.delete("/api/courses/{course_id}/candidates/{card_id}")
def reject_candidate(course_id: str, card_id: str):
    """Discard somebody the importer found who should not be in the course.

    Only unreviewed candidates can be rejected. An approved person is removed
    through the course's remove action instead, which is a different decision:
    that one may be discarding real study history.
    """
    with connection() as conn:
        card = conn.execute(
            "SELECT * FROM cards WHERE id = ? AND course_id = ? AND reviewed = 0", (card_id, course_id)
        ).fetchone()
        if not card:
            raise HTTPException(status_code=404, detail="No such candidate awaiting review")

        image_path = card["image_path"]
        conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        removed_asset = False
        if image_path and not conn.execute(
            "SELECT 1 FROM cards WHERE image_path = ? LIMIT 1", (image_path,)
        ).fetchone():
            asset = (ASSETS / image_path).resolve()
            if asset.is_file() and asset.is_relative_to(ASSETS.resolve()):
                asset.unlink()
                removed_asset = True
        return {"status": "rejected", "removed_portrait": removed_asset}


@app.post("/api/courses/{course_id}/candidates/{card_id}/approve")
def approve_candidate(course_id: str, card_id: str):
    with connection() as conn:
        updated = conn.execute(
            "UPDATE cards SET reviewed = 1 WHERE id = ? AND course_id = ?", (card_id, course_id)
        )
        if not updated.rowcount:
            raise HTTPException(status_code=404, detail="Candidate card not found")
        return {"status": "approved"}


@app.post("/api/courses/{course_id}/sessions")
def start_session(course_id: str, request: StartSessionRequest):
    if request.mode not in {"all", "adaptive", "morris", "continuous"}:
        raise HTTPException(status_code=400, detail="Mode must be all, adaptive, morris, or continuous")
    with connection() as conn:
        available = {
            row["id"]
            for row in conn.execute(
                "SELECT id FROM cards WHERE course_id = ? AND reviewed = 1", (course_id,)
            )
        }
        if not available:
            raise HTTPException(status_code=400, detail="Approve or add cards before starting a session")
        selected_ids = list(dict.fromkeys(request.card_ids))
        missing_ids = [card_id for card_id in selected_ids if card_id not in available]
        if missing_ids:
            raise HTTPException(status_code=400, detail="One or more cards are no longer available")
        session_id = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO study_sessions (id, course_id, mode, started_at, selected_count) VALUES (?, ?, ?, ?, ?)",
            (session_id, course_id, request.mode, now(), len(selected_ids)),
        )
        return {"id": session_id, "mode": request.mode, "selected_count": len(selected_ids)}


@app.post("/api/sessions/{session_id}/reviews")
def review(session_id: str, request: ReviewRequest):
    if request.result not in {"right", "wrong"}:
        raise HTTPException(status_code=400, detail="Result must be right or wrong")
    with connection() as conn:
        session = conn.execute("SELECT * FROM study_sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        card = conn.execute(
            "SELECT p.* FROM card_progress p JOIN cards c ON c.id = p.card_id WHERE p.card_id = ? AND c.course_id = ?",
            (request.card_id, session["course_id"]),
        ).fetchone()
        if not card:
            raise HTTPException(status_code=400, detail="Card is not part of this course")
        reviewed_at = _client_timestamp(request.reviewed_at)
        right_increment = 1 if request.result == "right" else 0
        wrong_increment = 1 if request.result == "wrong" else 0
        # The client computed these with the shared core; the server records them.
        # `confidence` is a legacy column kept in step with mastery for old rows.
        conn.execute(
            """
            UPDATE card_progress
            SET seen_count = seen_count + 1, right_count = right_count + ?, wrong_count = wrong_count + ?,
                confidence = ?, mastery = ?, stability_days = ?, last_reviewed_at = ?, last_result = ?
            WHERE card_id = ?
            """,
            (right_increment, wrong_increment, request.mastery, request.mastery, request.stability_days, reviewed_at, request.result, request.card_id),
        )
        conn.execute(
            "INSERT INTO review_events (session_id, card_id, reviewed_at, result) VALUES (?, ?, ?, ?)",
            (session_id, request.card_id, reviewed_at, request.result),
        )
        conn.execute(
            "UPDATE study_sessions SET reviewed_count = reviewed_count + 1, right_count = right_count + ?, wrong_count = wrong_count + ? WHERE id = ?",
            (right_increment, wrong_increment, session_id),
        )
        return {"status": "recorded"}


@app.post("/api/sessions/{session_id}/complete")
def complete_session(session_id: str, request: CompleteSessionRequest | None = None):
    with connection() as conn:
        session = conn.execute("SELECT * FROM study_sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        completed_at = now()
        conn.execute(
            """
            UPDATE study_sessions
            SET ended_at = COALESCE(ended_at, ?), readiness_at_completion = COALESCE(readiness_at_completion, ?)
            WHERE id = ?
            """,
            (completed_at, request.readiness if request else None, session_id),
        )
        session = conn.execute("SELECT * FROM study_sessions WHERE id = ?", (session_id,)).fetchone()
        result = dict(session)
        # `reviewed_count` counts attempts. Expanding recall shows a person more
        # than once and interleaves other cards, so it is not a count of people.
        result["people_count"] = conn.execute(
            "SELECT COUNT(DISTINCT card_id) AS people FROM review_events WHERE session_id = ?",
            (session_id,),
        ).fetchone()["people"]
        return result


def _export_response(bundle: bytes, stem: str) -> Response:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"familiar-{stem}-{stamp}.zip"
    return Response(
        content=bundle,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/import/bundle")
async def import_bundle(file: UploadFile = File(...)):
    """Restore a backup into this database.

    Refuses rather than merges, exactly as the restore CLI does: reconciling two
    divergent histories silently is how review events get lost. Restoring into a
    database that already holds these courses is therefore an error, not a
    merge.
    """
    if not (upload_name := file.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Choose a Familiar backup (.zip).")
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That backup is larger than this build accepts.")
    with connection() as conn:
        try:
            return restore_bundle(contents, conn, ASSETS)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read {upload_name}: {exc}") from exc


@app.get("/api/export")
def export_everything(include_progress: bool = True):
    """Download every course as one portable bundle. Read-only."""
    with connection() as conn:
        bundle = build_bundle(conn, ASSETS, None, include_progress)
    return _export_response(bundle, "backup" if include_progress else "rosters")


@app.get("/api/courses/{course_id}/export")
def export_course(course_id: str, include_progress: bool = True):
    """Download one course as a portable bundle. Read-only."""
    with connection() as conn:
        try:
            bundle = build_bundle(conn, ASSETS, [course_id], include_progress)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    stem = course_id if include_progress else f"{course_id}-roster"
    return _export_response(bundle, stem)


@app.delete("/api/courses/{course_id}/cards/{card_id}")
def remove_card(course_id: str, card_id: str):
    """Remove somebody who left the course, with their photo and their history.

    Deleting the portrait is deliberate rather than tidy-minded: a person who is
    no longer in the class should not leave their photograph on disk.
    """
    with connection() as conn:
        card = conn.execute(
            "SELECT * FROM cards WHERE id = ? AND course_id = ?", (card_id, course_id)
        ).fetchone()
        if not card:
            raise HTTPException(status_code=404, detail="That person is not in this course")

        image_path = card["image_path"]
        conn.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        # card_progress and review_events cascade from the cards row.

        removed_asset = False
        if image_path:
            still_used = conn.execute(
                "SELECT 1 FROM cards WHERE image_path = ? LIMIT 1", (image_path,)
            ).fetchone()
            if not still_used:
                asset = (ASSETS / image_path).resolve()
                # Refuse to follow a path out of the asset directory.
                if asset.is_file() and asset.is_relative_to(ASSETS.resolve()):
                    asset.unlink()
                    removed_asset = True
        return {"status": "removed", "removed_portrait": removed_asset}


@app.delete("/api/courses/{course_id}")
def delete_course(course_id: str, request: ResetCourseRequest):
    """Remove a class entirely, with its people, portraits and history.

    Guarded exactly as resetting is, and for the same reason: this destroys
    timestamped review events, which cannot be reconstructed from anything else.
    The caller has to repeat the class name back, so a stray request cannot do
    it.
    """
    with connection() as conn:
        course = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not course:
            raise HTTPException(status_code=404, detail="Course not found")
        if request.confirm_title.strip() != course["title"]:
            raise HTTPException(status_code=400, detail="Type the class name exactly to confirm deleting it.")

        counts = conn.execute(
            """
            SELECT (SELECT COUNT(*) FROM cards WHERE course_id = ?) AS people,
                   (SELECT COUNT(*) FROM study_sessions WHERE course_id = ?) AS sessions,
                   (SELECT COUNT(*) FROM review_events
                      WHERE session_id IN (SELECT id FROM study_sessions WHERE course_id = ?)) AS reviews
            """,
            (course_id, course_id, course_id),
        ).fetchone()

        # Portraits this course's people own outright. One shared with a card in
        # another class is left where it is.
        doomed = [
            row["image_path"]
            for row in conn.execute(
                """
                SELECT DISTINCT image_path FROM cards
                WHERE course_id = ? AND image_path IS NOT NULL
                  AND image_path NOT IN (SELECT image_path FROM cards WHERE course_id != ? AND image_path IS NOT NULL)
                """,
                (course_id, course_id),
            )
        ]
        # cards, card_progress, study_sessions and review_events all cascade.
        conn.execute("DELETE FROM courses WHERE id = ?", (course_id,))

        removed = 0
        for path in doomed:
            asset = (ASSETS / path).resolve()
            if asset.is_file() and asset.is_relative_to(ASSETS.resolve()):
                asset.unlink()
                removed += 1
        directory = (ASSETS / course_id).resolve()
        if directory.is_dir() and directory.is_relative_to(ASSETS.resolve()) and not any(directory.iterdir()):
            directory.rmdir()

        return {
            "status": "deleted",
            "people": counts["people"],
            "sessions": counts["sessions"],
            "reviews": counts["reviews"],
            "removed_portraits": removed,
        }


@app.post("/api/courses/{course_id}/reset")
def reset_course_progress(course_id: str, request: ResetCourseRequest):
    """Return every person in a course to unseen, discarding the study history.

    This is the one irreversible operation in the app, and what it destroys —
    timestamped review events — cannot be reconstructed from anything else. The
    caller has to repeat the course title back, so a stray request cannot do it.
    """
    with connection() as conn:
        course = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not course:
            raise HTTPException(status_code=404, detail="Course not found")
        if request.confirm_title.strip() != course["title"]:
            raise HTTPException(
                status_code=400,
                detail="Type the course title exactly to confirm resetting its progress.",
            )

        discarded = conn.execute(
            """
            SELECT COUNT(*) AS reviews,
                   (SELECT COUNT(*) FROM study_sessions WHERE course_id = ?) AS sessions
            FROM review_events
            WHERE session_id IN (SELECT id FROM study_sessions WHERE course_id = ?)
            """,
            (course_id, course_id),
        ).fetchone()

        conn.execute(
            """
            UPDATE card_progress
            SET seen_count = 0, right_count = 0, wrong_count = 0, confidence = 0,
                mastery = 0.5, stability_days = 0.25, last_reviewed_at = NULL, last_result = NULL
            WHERE card_id IN (SELECT id FROM cards WHERE course_id = ?)
            """,
            (course_id,),
        )
        # review_events cascade from study_sessions.
        conn.execute("DELETE FROM study_sessions WHERE course_id = ?", (course_id,))
        return {"status": "reset", "discarded_reviews": discarded["reviews"], "discarded_sessions": discarded["sessions"]}


# Mounted last, because a mount at the root would otherwise shadow every API
# route above it. Serving the frontend from "/" rather than "/static" is what
# lets the very same directory be published as a static site: every path inside
# it is relative, so nothing assumes a server is in front of it.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
