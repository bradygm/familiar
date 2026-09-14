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
                "INSERT INTO courses (id, title, source_filename, source_checksum, imported_at) VALUES (?, 'API Test', 'api.pdf', 'sum', '2026-01-01T00:00:00+00:00')",
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
