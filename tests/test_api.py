"""End-to-end tests for the HTTP surface.

The backend became storage-only without any API-level coverage, so everything
was verified by driving a browser once. These tests pin the contract instead:
what each endpoint accepts, what it stores, and what it refuses. They are the
answer to "it seems to work, but I would not know if something were hiding".

Each test gets its own temporary database, so none of this touches real data.
"""

import importlib
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

COURSE = "course-apitest"


@pytest.fixture
def client(tmp_path, monkeypatch):
    app_data = tmp_path / "app-data"
    (app_data / "assets").mkdir(parents=True)
    monkeypatch.setenv("FLASHCARDS_APP_DATA_DIR", str(app_data))
    monkeypatch.setenv("FLASHCARDS_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "data").mkdir()

    # main.py resolves the app-data directory at import time, so reload it under
    # the patched environment rather than letting tests share one database.
    from backend.app import database, main

    importlib.reload(database)
    importlib.reload(main)

    with TestClient(main.app) as test_client:
        with sqlite3.connect(app_data / "flashcards.sqlite3") as conn:
            conn.execute(
                "INSERT INTO courses (id, title, source_filename, imported_at) VALUES (?, 'API Test', 'api.pdf', '2026-01-01T00:00:00+00:00')",
                (COURSE,),
            )
            for index in range(4):
                card_id = f"{COURSE}-card-{index}"
                conn.execute(
                    "INSERT INTO cards (id, course_id, first_name, last_name, facts, reviewed, created_at) VALUES (?, ?, ?, ?, '', 1, '2026-01-01T00:00:00+00:00')",
                    (card_id, COURSE, f"First{index}", f"Last{index}"),
                )
                conn.execute("INSERT INTO card_progress (card_id) VALUES (?)", (card_id,))
            conn.commit()
        test_client.db_path = app_data / "flashcards.sqlite3"
        test_client.app_data = app_data
        yield test_client


def progress_row(client, card_id):
    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        return dict(conn.execute("SELECT * FROM card_progress WHERE card_id = ?", (card_id,)).fetchone())


def start_session(client, card_ids, mode="adaptive"):
    response = client.post(f"/api/courses/{COURSE}/sessions", json={"mode": mode, "card_ids": card_ids})
    assert response.status_code == 200, response.text
    return response.json()["id"]


# --- shape of what the server returns -------------------------------------


def test_courses_return_raw_progress_not_conclusions(client):
    """The model moved to the client, so the server must not report readiness."""
    course = client.get("/api/courses").json()[0]
    assert course["card_count"] == 4
    assert len(course["progress"]) == 4
    assert set(course["progress"][0]) == {"seen_count", "mastery", "stability_days", "last_reviewed_at"}
    assert "readiness" not in course
    assert "familiar_percent" not in course


def test_stats_return_raw_progress_not_conclusions(client):
    stats = client.get(f"/api/courses/{COURSE}/stats").json()
    assert len(stats["progress"]) == 4
    assert stats["readiness_trend"] == []
    for derived in ("readiness", "familiar_percent", "distribution"):
        assert derived not in stats


def test_stats_for_an_unknown_course_is_404(client):
    assert client.get("/api/courses/nope/stats").status_code == 404


def test_cards_can_be_ordered_by_either_name(client):
    first = [card["first_name"] for card in client.get(f"/api/courses/{COURSE}/cards?sort=first").json()]
    last = [card["last_name"] for card in client.get(f"/api/courses/{COURSE}/cards?sort=last").json()]
    assert first == sorted(first)
    assert last == sorted(last)


# --- starting a session ----------------------------------------------------


def test_session_records_the_cards_the_client_chose(client):
    session_id = start_session(client, [f"{COURSE}-card-0", f"{COURSE}-card-2"])
    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM study_sessions WHERE id = ?", (session_id,)).fetchone())
    assert row["selected_count"] == 2
    assert row["mode"] == "adaptive"


def test_session_rejects_cards_from_another_course(client):
    response = client.post(f"/api/courses/{COURSE}/sessions", json={"mode": "adaptive", "card_ids": ["not-a-card"]})
    assert response.status_code == 400
    assert "no longer available" in response.json()["detail"]


def test_session_requires_at_least_one_card(client):
    assert client.post(f"/api/courses/{COURSE}/sessions", json={"mode": "adaptive", "card_ids": []}).status_code == 422


def test_session_rejects_an_unknown_mode(client):
    response = client.post(f"/api/courses/{COURSE}/sessions", json={"mode": "telepathy", "card_ids": [f"{COURSE}-card-0"]})
    assert response.status_code == 400


def test_duplicate_card_ids_are_counted_once(client):
    card = f"{COURSE}-card-1"
    session_id = start_session(client, [card, card, card])
    with sqlite3.connect(client.db_path) as conn:
        assert conn.execute("SELECT selected_count FROM study_sessions WHERE id = ?", (session_id,)).fetchone()[0] == 1


# --- recording a review ----------------------------------------------------


def test_review_stores_exactly_what_the_client_computed(client):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    sent = {"card_id": card, "result": "right", "mastery": 0.6412345678901234, "stability_days": 1.2345678901234567, "reviewed_at": "2026-03-01T12:00:00.123456+00:00"}
    assert client.post(f"/api/sessions/{session_id}/reviews", json=sent).status_code == 200

    stored = progress_row(client, card)
    # Exact, not approximate: the server must not round or recompute.
    assert stored["mastery"] == sent["mastery"]
    assert stored["stability_days"] == sent["stability_days"]
    assert stored["seen_count"] == 1
    assert stored["right_count"] == 1
    assert stored["wrong_count"] == 0
    assert stored["last_result"] == "right"


def test_review_keeps_the_legacy_confidence_column_in_step_with_mastery(client):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.77, "stability_days": 2.0})
    assert progress_row(client, card)["confidence"] == 0.77


@pytest.mark.parametrize(
    "override",
    [
        {"mastery": 1.5},
        {"mastery": -0.1},
        {"stability_days": 0.0},
        {"stability_days": -1.0},
        {"stability_days": 10_000.0},
        {"result": "maybe"},
    ],
)
def test_review_rejects_implausible_values(client, override):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    payload = {"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0, **override}
    response = client.post(f"/api/sessions/{session_id}/reviews", json=payload)
    assert response.status_code in (400, 422), response.text
    assert progress_row(client, card)["seen_count"] == 0, "a rejected review must not be recorded"


def test_review_requires_the_computed_values(client):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    assert client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right"}).status_code == 422


def test_review_for_an_unknown_session_is_404(client):
    response = client.post("/api/sessions/nosuchsession/reviews", json={"card_id": f"{COURSE}-card-0", "result": "right", "mastery": 0.5, "stability_days": 1.0})
    assert response.status_code == 404


# --- the client clock guard ------------------------------------------------


def test_a_plausible_client_timestamp_is_stored_verbatim(client):
    """Stored state must be reproducible from the instant the client computed with."""
    from datetime import datetime, timezone

    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    moment = datetime.now(timezone.utc).isoformat()
    client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0, "reviewed_at": moment})
    assert progress_row(client, card)["last_reviewed_at"] == moment


@pytest.mark.parametrize("bad_clock", ["2019-01-01T00:00:00+00:00", "2099-01-01T00:00:00+00:00", "not-a-timestamp", "2026-03-01T12:00:00"])
def test_an_implausible_client_clock_is_replaced_with_the_servers(client, bad_clock):
    """A badly set clock would otherwise distort every later recall prediction."""
    from datetime import datetime, timezone

    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0, "reviewed_at": bad_clock})
    stored = progress_row(client, card)["last_reviewed_at"]
    assert stored != bad_clock
    assert abs((datetime.now(timezone.utc) - datetime.fromisoformat(stored)).total_seconds()) < 60


# --- completing a session --------------------------------------------------


def test_complete_stores_the_readiness_the_client_computed(client):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0})
    body = client.post(f"/api/sessions/{session_id}/complete", json={"readiness": 0.4242}).json()
    assert body["readiness_at_completion"] == 0.4242
    assert body["reviewed_count"] == 1


def test_complete_reports_people_separately_from_attempts(client):
    """Expanding recall repeats a person, so attempts are not a count of people."""
    cards = [f"{COURSE}-card-0", f"{COURSE}-card-1"]
    session_id = start_session(client, cards, mode="morris")
    for _ in range(3):
        for card in cards:
            client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0})
    body = client.post(f"/api/sessions/{session_id}/complete", json={"readiness": 0.5}).json()
    assert body["reviewed_count"] == 6
    assert body["people_count"] == 2


def test_completing_twice_keeps_the_first_result(client):
    session_id = start_session(client, [f"{COURSE}-card-0"])
    first = client.post(f"/api/sessions/{session_id}/complete", json={"readiness": 0.3}).json()
    second = client.post(f"/api/sessions/{session_id}/complete", json={"readiness": 0.9}).json()
    assert second["ended_at"] == first["ended_at"]
    assert second["readiness_at_completion"] == 0.3


def test_readiness_is_optional(client):
    session_id = start_session(client, [f"{COURSE}-card-0"])
    body = client.post(f"/api/sessions/{session_id}/complete", json={}).json()
    assert body["readiness_at_completion"] is None


# --- export ----------------------------------------------------------------


def test_export_returns_a_zip_attachment(client):
    response = client.get("/api/export")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "attachment" in response.headers["content-disposition"]
    assert response.content[:2] == b"PK"


def test_exporting_an_unknown_course_is_404(client):
    assert client.get("/api/courses/nope/export").status_code == 404


def test_adding_a_card_makes_it_immediately_studyable(client):
    created = client.post(f"/api/courses/{COURSE}/cards", json={"first_name": "New", "last_name": "Person", "facts": ["a fact"]})
    assert created.status_code == 200
    card_id = created.json()["id"]
    listed = {card["id"]: card for card in client.get(f"/api/courses/{COURSE}/cards").json()}
    assert listed[card_id]["facts"] == ["a fact"]
    assert start_session(client, [card_id])


# --- removing somebody who left the course -------------------------------


def test_removing_a_person_takes_their_progress_and_history_with_them(client):
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.5, "stability_days": 1.0})

    assert client.delete(f"/api/courses/{COURSE}/cards/{card}").status_code == 200
    with sqlite3.connect(client.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM cards WHERE id = ?", (card,)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM card_progress WHERE card_id = ?", (card,)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM review_events WHERE card_id = ?", (card,)).fetchone()[0] == 0


def test_removing_a_person_leaves_everybody_else_alone(client):
    before = client.get(f"/api/courses/{COURSE}/cards").json()
    client.delete(f"/api/courses/{COURSE}/cards/{COURSE}-card-0")
    after = client.get(f"/api/courses/{COURSE}/cards").json()
    assert len(after) == len(before) - 1
    assert {card["id"] for card in after} == {card["id"] for card in before} - {f"{COURSE}-card-0"}


def test_removing_a_person_deletes_their_portrait(client, tmp_path):
    """A person no longer in the class should not leave their photo on disk."""
    card = f"{COURSE}-card-1"
    relative = f"{COURSE}/portrait.jpg"
    portrait = Path(client.app_data) / "assets" / relative
    portrait.parent.mkdir(parents=True, exist_ok=True)
    portrait.write_bytes(b"\xff\xd8\xff\xd9")
    with sqlite3.connect(client.db_path) as conn:
        conn.execute("UPDATE cards SET image_path = ? WHERE id = ?", (relative, card))
        conn.commit()

    body = client.delete(f"/api/courses/{COURSE}/cards/{card}").json()
    assert body["removed_portrait"] is True
    assert not portrait.exists()


def test_a_portrait_shared_with_another_person_is_kept(client):
    shared = f"{COURSE}/shared.jpg"
    portrait = Path(client.app_data) / "assets" / shared
    portrait.parent.mkdir(parents=True, exist_ok=True)
    portrait.write_bytes(b"\xff\xd8\xff\xd9")
    with sqlite3.connect(client.db_path) as conn:
        conn.execute("UPDATE cards SET image_path = ? WHERE id IN (?, ?)", (shared, f"{COURSE}-card-2", f"{COURSE}-card-3"))
        conn.commit()

    body = client.delete(f"/api/courses/{COURSE}/cards/{COURSE}-card-2").json()
    assert body["removed_portrait"] is False
    assert portrait.exists()


def test_removing_somebody_from_the_wrong_course_is_404(client):
    assert client.delete(f"/api/courses/other-course/cards/{COURSE}-card-0").status_code == 404
    assert client.delete(f"/api/courses/{COURSE}/cards/nobody").status_code == 404


# --- resetting a course ----------------------------------------------------


def reviewed_course(client):
    cards = [f"{COURSE}-card-0", f"{COURSE}-card-1"]
    session_id = start_session(client, cards)
    for card in cards:
        client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.9, "stability_days": 8.0})
    client.post(f"/api/sessions/{session_id}/complete", json={"readiness": 0.5})
    return cards


def test_reset_returns_everybody_to_unseen_and_discards_the_history(client):
    reviewed_course(client)
    body = client.post(f"/api/courses/{COURSE}/reset", json={"confirm_title": "API Test"}).json()
    assert body == {"status": "reset", "discarded_reviews": 2, "discarded_sessions": 1}

    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute("SELECT * FROM card_progress")]
        assert conn.execute("SELECT COUNT(*) FROM study_sessions").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM review_events").fetchone()[0] == 0
    assert len(rows) == 4
    for row in rows:
        assert (row["seen_count"], row["right_count"], row["wrong_count"]) == (0, 0, 0)
        assert (row["mastery"], row["stability_days"]) == (0.5, 0.25)
        assert row["last_reviewed_at"] is None and row["last_result"] is None


def test_reset_keeps_the_people_themselves(client):
    reviewed_course(client)
    client.post(f"/api/courses/{COURSE}/reset", json={"confirm_title": "API Test"})
    assert len(client.get(f"/api/courses/{COURSE}/cards").json()) == 4


@pytest.mark.parametrize("wrong_title", ["", "api test", "API Tes", "Some Other Course"])
def test_reset_refuses_without_the_exact_course_title(client, wrong_title):
    """The one irreversible operation in the app must not fire by accident."""
    reviewed_course(client)
    response = client.post(f"/api/courses/{COURSE}/reset", json={"confirm_title": wrong_title})
    assert response.status_code in (400, 422)
    with sqlite3.connect(client.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM review_events").fetchone()[0] == 2, "a refused reset must destroy nothing"


def test_reset_tolerates_surrounding_whitespace_in_the_confirmation(client):
    reviewed_course(client)
    assert client.post(f"/api/courses/{COURSE}/reset", json={"confirm_title": "  API Test  "}).status_code == 200


def test_reset_of_an_unknown_course_is_404(client):
    assert client.post("/api/courses/nope/reset", json={"confirm_title": "API Test"}).status_code == 404


def test_a_course_can_be_studied_again_after_a_reset(client):
    reviewed_course(client)
    client.post(f"/api/courses/{COURSE}/reset", json={"confirm_title": "API Test"})
    card = f"{COURSE}-card-0"
    session_id = start_session(client, [card])
    assert client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.6, "stability_days": 1.5}).status_code == 200
    assert progress_row(client, card)["seen_count"] == 1


# --- starting a class from an upload --------------------------------------


def roster_pdf(names, path):
    """A text-based roster PDF, so the importer's fast path reads it without OCR."""
    from pypdf import PdfWriter
    import io

    try:
        from reportlab.pdfgen import canvas  # noqa: F401
    except ImportError:
        pytest.skip("reportlab not installed; upload tests need a generated PDF")
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    page = canvas.Canvas(buffer)
    for index, (first, last) in enumerate(names):
        page.drawString(100, 780 - index * 40, f"{first} {last}")
    page.save()
    path.write_bytes(buffer.getvalue())
    return path


def upload_roster(client, path, url="/api/courses", **fields):
    with path.open("rb") as handle:
        return client.post(url, files={"file": (path.name, handle, "application/pdf")}, data=fields)


def test_a_class_is_created_from_an_uploaded_roster(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace"), ("Alan", "Turing")], tmp_path / "ME EN 101.pdf")
    body = upload_roster(client, pdf).json()
    assert body["status"] == "created"
    assert body["added"] == 2
    candidates = client.get(f"/api/courses/{body['course_id']}/candidates").json()
    assert {(c["first_name"], c["last_name"]) for c in candidates} == {("Ada", "Lovelace"), ("Alan", "Turing")}


def test_new_people_arrive_unapproved_so_they_go_through_review(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "roster.pdf")
    course_id = upload_roster(client, pdf).json()["course_id"]
    assert client.get(f"/api/courses/{course_id}/cards").json() == []
    assert len(client.get(f"/api/courses/{course_id}/candidates").json()) == 1


def test_the_same_roster_can_seed_two_separate_classes(client, tmp_path):
    """Two sections of one course are a real case; the old UNIQUE checksum banned it."""
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "shared.pdf")
    first = upload_roster(client, pdf).json()
    second = upload_roster(client, pdf).json()
    assert first["course_id"] != second["course_id"]
    assert second["added"] == 1


def test_a_title_can_be_given_and_otherwise_comes_from_the_filename(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "ME_EN_101_W26.pdf")
    named = upload_roster(client, pdf, title="Thermodynamics").json()
    assert client.get(f"/api/courses/{named['course_id']}").json()["title"] == "Thermodynamics"
    unnamed = upload_roster(client, pdf).json()
    assert client.get(f"/api/courses/{unnamed['course_id']}").json()["title"] == "ME EN 101 W26"


@pytest.mark.parametrize("filename,content", [("notes.txt", b"hello"), ("roster.pdf", b"")])
def test_an_unusable_upload_is_refused(client, tmp_path, filename, content):
    path = tmp_path / filename
    path.write_bytes(content)
    assert upload_roster(client, path).status_code == 400


def test_a_file_that_is_not_really_a_pdf_is_refused_without_creating_a_class(client, tmp_path):
    path = tmp_path / "pretend.pdf"
    path.write_bytes(b"this is not a pdf")
    assert upload_roster(client, path).status_code == 422
    assert client.get("/api/courses").json() == [] or all(
        course["id"] != "pretend" for course in client.get("/api/courses").json()
    )


# --- adding people to a class that already exists -------------------------


def test_a_later_roster_adds_only_the_new_people(client, tmp_path):
    """The whole point: somebody joins late, and nobody else is disturbed."""
    first = roster_pdf([("Ada", "Lovelace"), ("Alan", "Turing")], tmp_path / "week1.pdf")
    course_id = upload_roster(client, first).json()["course_id"]
    for candidate in client.get(f"/api/courses/{course_id}/candidates").json():
        client.post(f"/api/courses/{course_id}/candidates/{candidate['id']}/approve")

    # Study one of them, so there is history that must survive.
    studied = client.get(f"/api/courses/{course_id}/cards").json()[0]["id"]
    session = client.post(f"/api/courses/{course_id}/sessions", json={"mode": "adaptive", "card_ids": [studied]})
    assert session.status_code == 200, session.text
    client.post(f"/api/sessions/{session.json()['id']}/reviews", json={"card_id": studied, "result": "right", "mastery": 0.9, "stability_days": 6.0})

    later = roster_pdf([("Ada", "Lovelace"), ("Alan", "Turing"), ("Grace", "Hopper")], tmp_path / "week3.pdf")
    body = upload_roster(client, later, url=f"/api/courses/{course_id}/imports").json()
    assert body["status"] == "updated"
    assert body["added"] == 1
    assert body["already_present"] == 2
    assert body["course_id"] == course_id

    candidates = client.get(f"/api/courses/{course_id}/candidates").json()
    assert [(c["first_name"], c["last_name"]) for c in candidates] == [("Grace", "Hopper")]
    assert progress_row(client, studied)["seen_count"] == 1, "existing study history must survive a re-import"


def test_re_importing_an_unchanged_roster_adds_nobody(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace"), ("Alan", "Turing")], tmp_path / "roster.pdf")
    course_id = upload_roster(client, pdf).json()["course_id"]
    body = upload_roster(client, pdf, url=f"/api/courses/{course_id}/imports").json()
    assert body["added"] == 0
    assert body["already_present"] == 2
    assert "already in the course" in body["warning"]


def test_importing_creates_no_second_class(client, tmp_path):
    """The bug this design removes: a re-export used to become a duplicate class."""
    first = roster_pdf([("Ada", "Lovelace")], tmp_path / "a.pdf")
    course_id = upload_roster(client, first).json()["course_id"]
    before = len(client.get("/api/courses").json())
    later = roster_pdf([("Ada", "Lovelace"), ("Grace", "Hopper")], tmp_path / "b.pdf")
    upload_roster(client, later, url=f"/api/courses/{course_id}/imports")
    assert len(client.get("/api/courses").json()) == before


def test_two_sections_can_be_merged_into_one_class(client, tmp_path):
    section_one = roster_pdf([("Ada", "Lovelace")], tmp_path / "s1.pdf")
    section_two = roster_pdf([("Grace", "Hopper")], tmp_path / "s2.pdf")
    course_id = upload_roster(client, section_one).json()["course_id"]
    body = upload_roster(client, section_two, url=f"/api/courses/{course_id}/imports").json()
    assert body["added"] == 1
    assert len(client.get(f"/api/courses/{course_id}/candidates").json()) == 2


def test_importing_into_a_course_that_does_not_exist_is_refused(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "roster.pdf")
    assert upload_roster(client, pdf, url="/api/courses/nope/imports").status_code == 400


def test_the_uploaded_pdf_is_not_kept(client, tmp_path):
    """The learner has the file already; keeping student rosters buys nothing."""
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "roster.pdf")
    upload_roster(client, pdf)
    stored = [path.name for path in Path(client.app_data).rglob("*.pdf")]
    assert stored == []


def test_provenance_is_recorded_even_though_the_file_is_discarded(client, tmp_path):
    pdf = roster_pdf([("Ada", "Lovelace")], tmp_path / "ME EN 101.pdf")
    upload_roster(client, pdf)
    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        run = dict(conn.execute("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1").fetchone())
    assert run["source_filename"] == "ME EN 101.pdf"
    assert len(run["source_checksum"]) == 64
    assert run["status"] == "complete"


# --- portraits must not collide between imports ---------------------------


class _FakePage:
    """A page with no embedded text, so the importer takes its OCR path."""

    def extract_text(self):
        return ""


def fake_pdf_reader(_path):
    return type("FakeReader", (), {"pages": [_FakePage()]})()


def portrait_paths(client, course_id):
    with sqlite3.connect(client.db_path) as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT image_path FROM cards WHERE course_id = ? AND image_path IS NOT NULL", (course_id,)
            )
        ]


def test_two_people_never_share_a_portrait_file(client, tmp_path, monkeypatch):
    """The bug this guards: portraits were named page-NN-person-NN, which is only
    unique within one PDF. A second roster imported into the same class
    overwrote the first roster's files, silently giving existing people
    somebody else's face."""
    from backend.app import importer

    # Stand in for OCR: every roster yields a portrait for each person, and the
    # crops are named identically across imports, exactly as page/position would.
    def fake_ocr(path, staging):
        names = [line.split(" ", 1) for line in path.read_text().splitlines() if line.strip()]
        candidates = []
        for index, (first, last) in enumerate(names, start=1):
            crop = staging / f"page-01-person-{index:02d}.jpg"
            crop.write_bytes(f"portrait of {first} {last}".encode())
            candidates.append({"first_name": first, "last_name": last, "staged_portrait": crop})
        return "", 1, candidates

    monkeypatch.setattr(importer, "_ocr_pdf", fake_ocr)
    monkeypatch.setattr(importer, "PdfReader", fake_pdf_reader)

    first = tmp_path / "first.pdf"
    first.write_text("Ada Lovelace\nAlan Turing\n")
    with first.open("rb") as handle:
        created = client.post("/api/courses", files={"file": ("first.pdf", handle, "application/pdf")}).json()
    course_id = created["course_id"]
    before = portrait_paths(client, course_id)
    assert len(before) == 2

    # A later roster: the same two people plus one more, crops named the same.
    second = tmp_path / "second.pdf"
    second.write_text("Ada Lovelace\nAlan Turing\nGrace Hopper\n")
    with second.open("rb") as handle:
        client.post(f"/api/courses/{course_id}/imports", files={"file": ("second.pdf", handle, "application/pdf")})

    after = portrait_paths(client, course_id)
    assert len(after) == 3
    assert len(set(after)) == 3, "every person must have their own portrait file"
    assert set(before).issubset(set(after)), "existing people must keep the portrait they had"

    # And the files themselves must still hold the right faces.
    assets = Path(client.app_data) / "assets"
    with sqlite3.connect(client.db_path) as conn:
        for first_name, last_name, image_path in conn.execute(
            "SELECT first_name, last_name, image_path FROM cards WHERE course_id = ? AND image_path IS NOT NULL",
            (course_id,),
        ):
            assert (assets / image_path).read_bytes() == f"portrait of {first_name} {last_name}".encode()


def test_a_third_roster_cannot_overwrite_a_portrait_from_the_second(client, tmp_path, monkeypatch):
    """The naming half of the fix.

    Not storing portraits for people already present stops the obvious
    collision, but a *new* person in a later roster can still land in the same
    page-and-position slot as a new person from an earlier one. If portrait
    names came from that slot, the later import would overwrite the earlier
    person's face. Names are unrelated to position for exactly this reason.
    """
    from backend.app import importer

    def fake_ocr(path, staging):
        candidates = []
        for index, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            first, last = line.split(" ", 1)
            # Named by slot, as a page-and-position crop inevitably is.
            crop = staging / f"page-01-person-{index:02d}.jpg"
            crop.write_bytes(f"portrait of {first} {last}".encode())
            candidates.append({"first_name": first, "last_name": last, "staged_portrait": crop})
        return "", 1, candidates

    monkeypatch.setattr(importer, "_ocr_pdf", fake_ocr)
    monkeypatch.setattr(importer, "PdfReader", fake_pdf_reader)

    def send(text, url="/api/courses"):
        roster = tmp_path / "roster.pdf"
        roster.write_text(text)
        with roster.open("rb") as handle:
            return client.post(url, files={"file": ("roster.pdf", handle, "application/pdf")}).json()

    course_id = send("Ada Lovelace\n")["course_id"]
    # Grace is new, and lands in slot 2.
    send("Ada Lovelace\nGrace Hopper\n", f"/api/courses/{course_id}/imports")
    # Zed is new too, and lands in slot 2 as well — Grace is not on this roster.
    send("Ada Lovelace\nZed Zhang\n", f"/api/courses/{course_id}/imports")

    assets = Path(client.app_data) / "assets"
    with sqlite3.connect(client.db_path) as conn:
        stored = list(
            conn.execute(
                "SELECT first_name, last_name, image_path FROM cards WHERE course_id = ? AND image_path IS NOT NULL",
                (course_id,),
            )
        )
    assert len(stored) == 3
    assert len({row[2] for row in stored}) == 3, "each person needs their own file"
    for first_name, last_name, image_path in stored:
        assert (assets / image_path).read_bytes() == f"portrait of {first_name} {last_name}".encode(), (
            f"{first_name} {last_name} is showing somebody else's face"
        )


def test_an_import_writes_no_portrait_for_somebody_already_present(client, tmp_path, monkeypatch):
    """Otherwise every re-import leaves a full set of orphaned files behind."""
    from backend.app import importer

    def fake_ocr(path, staging):
        candidates = []
        for index, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            first, last = line.split(" ", 1)
            crop = staging / f"page-01-person-{index:02d}.jpg"
            crop.write_bytes(b"x")
            candidates.append({"first_name": first, "last_name": last, "staged_portrait": crop})
        return "", 1, candidates

    monkeypatch.setattr(importer, "_ocr_pdf", fake_ocr)
    monkeypatch.setattr(importer, "PdfReader", fake_pdf_reader)

    roster = tmp_path / "roster.pdf"
    roster.write_text("Ada Lovelace\n")
    with roster.open("rb") as handle:
        course_id = client.post("/api/courses", files={"file": ("r.pdf", handle, "application/pdf")}).json()["course_id"]

    assets = Path(client.app_data) / "assets"
    after_first = sorted(p.name for p in assets.rglob("*.jpg"))
    with roster.open("rb") as handle:
        client.post(f"/api/courses/{course_id}/imports", files={"file": ("r.pdf", handle, "application/pdf")})
    assert sorted(p.name for p in assets.rglob("*.jpg")) == after_first


# --- rejecting a candidate -------------------------------------------------


def test_a_candidate_can_be_rejected(client):
    with sqlite3.connect(client.db_path) as conn:
        conn.execute(
            "INSERT INTO cards (id, course_id, first_name, last_name, facts, reviewed, created_at) VALUES ('cand-x', ?, 'Not', 'Astudent', '', 0, '2026-01-01T00:00:00+00:00')",
            (COURSE,),
        )
        conn.execute("INSERT INTO card_progress (card_id) VALUES ('cand-x')")
        conn.commit()

    assert len(client.get(f"/api/courses/{COURSE}/candidates").json()) == 1
    assert client.delete(f"/api/courses/{COURSE}/candidates/cand-x").status_code == 200
    assert client.get(f"/api/courses/{COURSE}/candidates").json() == []
    with sqlite3.connect(client.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM cards WHERE id = 'cand-x'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM card_progress WHERE card_id = 'cand-x'").fetchone()[0] == 0


def test_rejecting_does_not_touch_approved_people(client):
    """An approved person may have study history; discarding them is a different
    decision, made through the course's remove action."""
    approved = f"{COURSE}-card-0"
    assert client.delete(f"/api/courses/{COURSE}/candidates/{approved}").status_code == 404
    assert any(card["id"] == approved for card in client.get(f"/api/courses/{COURSE}/cards").json())


def test_rejecting_an_unknown_candidate_is_404(client):
    assert client.delete(f"/api/courses/{COURSE}/candidates/nobody").status_code == 404


# --- restoring a backup through the app ------------------------------------


def test_a_backup_can_be_restored_through_the_api(client, tmp_path):
    """Restoring is how a fresh install gets its data back; the CLI should not be
    the only route to it."""
    from backend.app.portable import build_bundle

    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        bundle = build_bundle(conn, Path(client.app_data) / "assets")
    archive = tmp_path / "backup.zip"
    archive.write_bytes(bundle)

    # Into a database that already has the course, restoring must refuse.
    with archive.open("rb") as handle:
        clash = client.post("/api/import/bundle", files={"file": ("backup.zip", handle, "application/zip")})
    assert clash.status_code == 400
    assert "already exist" in clash.json()["detail"]

    # Into an empty one, it restores everything.
    with sqlite3.connect(client.db_path) as conn:
        # The app's own connections enable this; a raw one does not, and without
        # it deleting a course leaves its cards behind.
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM courses")
        conn.commit()
    with archive.open("rb") as handle:
        restored = client.post("/api/import/bundle", files={"file": ("backup.zip", handle, "application/zip")})
    assert restored.status_code == 200, restored.text
    assert restored.json()["courses"] == 1
    assert restored.json()["cards"] == 4
    assert len(client.get(f"/api/courses/{COURSE}/cards").json()) == 4


def test_restoring_a_refused_backup_changes_nothing(client, tmp_path):
    from backend.app.portable import build_bundle

    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        bundle = build_bundle(conn, Path(client.app_data) / "assets")
    archive = tmp_path / "backup.zip"
    archive.write_bytes(bundle)
    before = client.get(f"/api/courses/{COURSE}/cards").json()
    with archive.open("rb") as handle:
        client.post("/api/import/bundle", files={"file": ("backup.zip", handle, "application/zip")})
    assert client.get(f"/api/courses/{COURSE}/cards").json() == before


@pytest.mark.parametrize("name,content", [("notes.txt", b"hello"), ("backup.zip", b"not really a zip")])
def test_an_unusable_backup_is_refused(client, tmp_path, name, content):
    path = tmp_path / name
    path.write_bytes(content)
    with path.open("rb") as handle:
        response = client.post("/api/import/bundle", files={"file": (name, handle, "application/zip")})
    assert response.status_code in (400, 422)
