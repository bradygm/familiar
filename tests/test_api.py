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
    created = client.post(
        f"/api/courses/{COURSE}/cards",
        data={"first_name": "New", "last_name": "Person", "facts": json.dumps(["a fact"])},
    )
    assert created.status_code == 200, created.text
    card_id = created.json()["id"]
    listed = {card["id"]: card for card in client.get(f"/api/courses/{COURSE}/cards").json()}
    assert listed[card_id]["facts"] == ["a fact"]
    assert listed[card_id]["image_path"] is None
    assert start_session(client, [card_id])


def test_somebody_added_by_hand_can_have_a_photo(client):
    """The importer misses people, and a card with no face is a poor flashcard."""
    created = client.post(
        f"/api/courses/{COURSE}/cards",
        data={"first_name": "Photo", "last_name": "Person", "facts": "[]"},
        files={"portrait": ("face.jpg", b"a portrait", "image/jpeg")},
    )
    assert created.status_code == 200, created.text
    card_id = created.json()["id"]
    listed = {card["id"]: card for card in client.get(f"/api/courses/{COURSE}/cards").json()}
    stored = listed[card_id]["image_path"]
    assert stored and stored.startswith(f"{COURSE}/person-")
    assert (Path(client.app_data) / "assets" / stored).read_bytes() == b"a portrait"


def test_adding_somebody_without_a_name_is_refused(client):
    before = len(client.get(f"/api/courses/{COURSE}/cards").json())
    response = client.post(f"/api/courses/{COURSE}/cards", data={"first_name": "  ", "last_name": "Person"})
    assert response.status_code in (400, 422)
    assert len(client.get(f"/api/courses/{COURSE}/cards").json()) == before


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


# --- starting a class from a roster the browser read ----------------------


def roster_form(people, *, filename="ME EN 101.pdf", pages=1, title=None):
    """Build the multipart body the browser sends after reading a roster.

    Each person may carry `portrait`, an index into the uploaded crops, which is
    how a face is matched to a name now that the server never sees the PDF.
    """
    described = []
    files = []
    for index, (first, last, has_portrait) in enumerate(people):
        described.append(
            {"first_name": first, "last_name": last, "portrait": len(files) if has_portrait else None}
        )
        if has_portrait:
            files.append(("portraits", (f"p{index}.jpg", f"portrait of {first} {last}".encode(), "image/jpeg")))
    data = {
        "people": json.dumps(described),
        "source_filename": filename,
        "source_checksum": "a" * 64,
        "pages": str(pages),
    }
    if title:
        data["title"] = title
    return data, files


def send_roster(client, people, url="/api/courses", **kwargs):
    data, files = roster_form(people, **kwargs)
    return client.post(url, data=data, files=files or None)


def test_a_class_is_created_from_a_roster(client):
    body = send_roster(client, [("Ada", "Lovelace", True), ("Alan", "Turing", False)]).json()
    assert body["status"] == "created"
    assert body["added"] == 2
    candidates = client.get(f"/api/courses/{body['course_id']}/candidates").json()
    assert {(c["first_name"], c["last_name"]) for c in candidates} == {("Ada", "Lovelace"), ("Alan", "Turing")}
    # Only the person who had a portrait gets one.
    assert sum(1 for c in candidates if c["image_path"]) == 1


def test_new_people_arrive_unapproved_so_they_go_through_review(client):
    course_id = send_roster(client, [("Ada", "Lovelace", False)]).json()["course_id"]
    assert client.get(f"/api/courses/{course_id}/cards").json() == []
    assert len(client.get(f"/api/courses/{course_id}/candidates").json()) == 1


def test_the_same_roster_can_seed_two_separate_classes(client):
    """Two sections of one course are a real case; the old UNIQUE checksum banned it."""
    first = send_roster(client, [("Ada", "Lovelace", False)]).json()
    second = send_roster(client, [("Ada", "Lovelace", False)]).json()
    assert first["course_id"] != second["course_id"]
    assert second["added"] == 1


def test_a_title_can_be_given_and_otherwise_comes_from_the_filename(client):
    named = send_roster(client, [("Ada", "Lovelace", False)], title="Thermodynamics").json()
    assert client.get(f"/api/courses/{named['course_id']}").json()["title"] == "Thermodynamics"
    unnamed = send_roster(client, [("Ada", "Lovelace", False)], filename="ME_EN_101_W26.pdf").json()
    assert client.get(f"/api/courses/{unnamed['course_id']}").json()["title"] == "ME EN 101 W26"


@pytest.mark.parametrize("people_json", ["not json", '{"not": "a list"}', '[{"first_name": "", "last_name": "X"}]'])
def test_malformed_roster_data_is_refused(client, people_json):
    response = client.post(
        "/api/courses",
        data={"people": people_json, "source_filename": "r.pdf", "source_checksum": "x", "pages": "1"},
    )
    assert response.status_code == 400


def test_the_server_never_receives_the_pdf(client):
    """Extraction happens in the browser, so no roster file should ever land here."""
    send_roster(client, [("Ada", "Lovelace", True)])
    assert [path.name for path in Path(client.app_data).rglob("*.pdf")] == []


def test_provenance_is_recorded_even_though_the_file_never_arrives(client):
    send_roster(client, [("Ada", "Lovelace", False)], filename="ME EN 101.pdf", pages=23)
    with sqlite3.connect(client.db_path) as conn:
        conn.row_factory = sqlite3.Row
        run = dict(conn.execute("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1").fetchone())
    assert run["source_filename"] == "ME EN 101.pdf"
    assert run["pages"] == 23
    assert run["status"] == "complete"


# --- adding people to a class that already exists -------------------------


def test_a_later_roster_adds_only_the_new_people(client):
    """The whole point: somebody joins late, and nobody else is disturbed."""
    course_id = send_roster(client, [("Ada", "Lovelace", True), ("Alan", "Turing", True)]).json()["course_id"]
    for candidate in client.get(f"/api/courses/{course_id}/candidates").json():
        client.post(f"/api/courses/{course_id}/candidates/{candidate['id']}/approve")

    studied = client.get(f"/api/courses/{course_id}/cards").json()[0]["id"]
    session = client.post(f"/api/courses/{course_id}/sessions", json={"mode": "adaptive", "card_ids": [studied]})
    client.post(f"/api/sessions/{session.json()['id']}/reviews", json={"card_id": studied, "result": "right", "mastery": 0.9, "stability_days": 6.0})

    body = send_roster(
        client,
        [("Ada", "Lovelace", True), ("Alan", "Turing", True), ("Grace", "Hopper", True)],
        url=f"/api/courses/{course_id}/imports",
    ).json()
    assert body["status"] == "updated"
    assert body["added"] == 1
    assert body["already_present"] == 2

    candidates = client.get(f"/api/courses/{course_id}/candidates").json()
    assert [(c["first_name"], c["last_name"]) for c in candidates] == [("Grace", "Hopper")]
    assert progress_row(client, studied)["seen_count"] == 1, "existing study history must survive a re-import"


def test_re_importing_an_unchanged_roster_adds_nobody(client):
    people = [("Ada", "Lovelace", True), ("Alan", "Turing", True)]
    course_id = send_roster(client, people).json()["course_id"]
    body = send_roster(client, people, url=f"/api/courses/{course_id}/imports").json()
    assert body["added"] == 0
    assert body["already_present"] == 2
    assert "already in the course" in body["warning"]


def test_importing_creates_no_second_class(client):
    """The bug this design removes: a re-export used to become a duplicate class."""
    course_id = send_roster(client, [("Ada", "Lovelace", False)]).json()["course_id"]
    before = len(client.get("/api/courses").json())
    send_roster(client, [("Ada", "Lovelace", False), ("Grace", "Hopper", False)], url=f"/api/courses/{course_id}/imports")
    assert len(client.get("/api/courses").json()) == before


def test_two_sections_can_be_merged_into_one_class(client):
    course_id = send_roster(client, [("Ada", "Lovelace", False)]).json()["course_id"]
    body = send_roster(client, [("Grace", "Hopper", False)], url=f"/api/courses/{course_id}/imports").json()
    assert body["added"] == 1
    assert len(client.get(f"/api/courses/{course_id}/candidates").json()) == 2


def test_importing_into_a_course_that_does_not_exist_is_refused(client):
    assert send_roster(client, [("Ada", "Lovelace", False)], url="/api/courses/nope/imports").status_code == 400


# --- portraits must not collide between imports ---------------------------


def portrait_paths(client, course_id):
    with sqlite3.connect(client.db_path) as conn:
        return [
            row[0]
            for row in conn.execute(
                "SELECT image_path FROM cards WHERE course_id = ? AND image_path IS NOT NULL", (course_id,)
            )
        ]


def test_two_people_never_share_a_portrait_file(client):
    """The bug this guards: portraits were once named by page and position, which
    is only unique within one roster, so a second import overwrote the first
    roster's files and gave existing people somebody else's face."""
    course_id = send_roster(client, [("Ada", "Lovelace", True), ("Alan", "Turing", True)]).json()["course_id"]
    before = portrait_paths(client, course_id)
    assert len(before) == 2

    send_roster(
        client,
        [("Ada", "Lovelace", True), ("Alan", "Turing", True), ("Grace", "Hopper", True)],
        url=f"/api/courses/{course_id}/imports",
    )
    after = portrait_paths(client, course_id)
    assert len(after) == 3
    assert len(set(after)) == 3, "every person must have their own portrait file"
    assert set(before).issubset(set(after)), "existing people must keep the portrait they had"

    assets = Path(client.app_data) / "assets"
    with sqlite3.connect(client.db_path) as conn:
        for first_name, last_name, image_path in conn.execute(
            "SELECT first_name, last_name, image_path FROM cards WHERE course_id = ? AND image_path IS NOT NULL",
            (course_id,),
        ):
            assert (assets / image_path).read_bytes() == f"portrait of {first_name} {last_name}".encode()


def test_an_existing_portrait_is_never_replaced(client):
    """Changing a face out from under somebody mid-semester is its own kind of wrong."""
    course_id = send_roster(client, [("Ada", "Lovelace", True)]).json()["course_id"]
    original = portrait_paths(client, course_id)[0]
    send_roster(client, [("Ada", "Lovelace", True)], url=f"/api/courses/{course_id}/imports")
    assert portrait_paths(client, course_id) == [original]


def test_a_portrait_fills_a_gap_for_somebody_who_had_none(client):
    course_id = send_roster(client, [("Ada", "Lovelace", False)]).json()["course_id"]
    assert portrait_paths(client, course_id) == []
    send_roster(client, [("Ada", "Lovelace", True)], url=f"/api/courses/{course_id}/imports")
    assert len(portrait_paths(client, course_id)) == 1


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


# --- deleting a class -------------------------------------------------------


def test_deleting_a_class_removes_it_and_everything_in_it(client):
    cards = [f"{COURSE}-card-0", f"{COURSE}-card-1"]
    session_id = start_session(client, cards)
    for card in cards:
        client.post(f"/api/sessions/{session_id}/reviews", json={"card_id": card, "result": "right", "mastery": 0.8, "stability_days": 3.0})

    body = client.request("DELETE", f"/api/courses/{COURSE}", json={"confirm_title": "API Test"}).json()
    assert body["status"] == "deleted"
    assert body["people"] == 4
    assert body["reviews"] == 2

    assert client.get("/api/courses").json() == []
    with sqlite3.connect(client.db_path) as conn:
        for table in ("courses", "cards", "card_progress", "study_sessions", "review_events"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table


def test_deleting_a_class_takes_its_portraits_with_it(client):
    relative = f"{COURSE}/portrait.jpg"
    portrait = Path(client.app_data) / "assets" / relative
    portrait.parent.mkdir(parents=True, exist_ok=True)
    portrait.write_bytes(b"\xff\xd8\xff\xd9")
    with sqlite3.connect(client.db_path) as conn:
        conn.execute("UPDATE cards SET image_path = ? WHERE id = ?", (relative, f"{COURSE}-card-0"))
        conn.commit()

    body = client.request("DELETE", f"/api/courses/{COURSE}", json={"confirm_title": "API Test"}).json()
    assert body["removed_portraits"] == 1
    assert not portrait.exists()


@pytest.mark.parametrize("wrong", ["", "api test", "API Tes", "Another Class"])
def test_deleting_refuses_without_the_exact_class_name(client, wrong):
    response = client.request("DELETE", f"/api/courses/{COURSE}", json={"confirm_title": wrong})
    assert response.status_code in (400, 422)
    assert len(client.get("/api/courses").json()) == 1, "a refused delete must remove nothing"
    assert len(client.get(f"/api/courses/{COURSE}/cards").json()) == 4


def test_deleting_an_unknown_class_is_404(client):
    assert client.request("DELETE", "/api/courses/nope", json={"confirm_title": "API Test"}).status_code == 404


def test_deleting_one_class_leaves_another_alone(client):
    other = send_roster(client, [("Ada", "Lovelace", True)], title="Other Class").json()["course_id"]
    client.request("DELETE", f"/api/courses/{COURSE}", json={"confirm_title": "API Test"})
    remaining = client.get("/api/courses").json()
    assert [course["id"] for course in remaining] == [other]
    assert len(client.get(f"/api/courses/{other}/candidates").json()) == 1
