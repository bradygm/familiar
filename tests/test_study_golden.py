"""Pin the learning model's behaviour before it is ported to TypeScript.

These tests are deliberately dumb: they assert that today's model produces
exactly today's numbers. Their value is that the shared core cannot silently
change the meaning of a learner's stored mastery and stability.
"""

import json
import math
from datetime import datetime
from pathlib import Path

import pytest

from backend.app.study import (
    adaptive_cards,
    course_readiness,
    days_since,
    predicted_recall,
    selection_score,
    update_memory_state,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "study_vectors.json").read_text())
NOW = datetime.fromisoformat(VECTORS["now"])

# Tight enough to catch a changed coefficient, loose enough to survive
# float formatting differences between Python and JavaScript.
TOLERANCE = 1e-12


def ids(prefix, cases):
    return [f"{prefix}{index}" for index in range(len(cases))]


@pytest.mark.parametrize("case", VECTORS["days_since"], ids=ids("days_since-", VECTORS["days_since"]))
def test_days_since(case):
    assert days_since(case["timestamp"], NOW) == pytest.approx(case["expected"], abs=TOLERANCE)


@pytest.mark.parametrize("case", VECTORS["predicted_recall"], ids=ids("recall-", VECTORS["predicted_recall"]))
def test_predicted_recall(case):
    actual = predicted_recall(case["mastery"], case["stability_days"], case["days_since_review"])
    assert actual == pytest.approx(case["expected"], abs=TOLERANCE)
    assert 0.01 <= actual <= 0.99


@pytest.mark.parametrize("case", VECTORS["selection_score"], ids=ids("score-", VECTORS["selection_score"]))
def test_selection_score(case):
    actual = selection_score(case["seen_count"], case["recall"])
    assert actual == pytest.approx(case["expected"], abs=TOLERANCE)


@pytest.mark.parametrize("case", VECTORS["update_memory_state"], ids=ids("memory-", VECTORS["update_memory_state"]))
def test_update_memory_state(case):
    actual = update_memory_state(dict(case["progress"]), case["result"], datetime.fromisoformat(case["reviewed_at"]))
    assert actual["mastery"] == pytest.approx(case["expected"]["mastery"], abs=TOLERANCE)
    assert actual["stability_days"] == pytest.approx(case["expected"]["stability_days"], abs=TOLERANCE)


@pytest.mark.parametrize("case", VECTORS["course_readiness"], ids=ids("readiness-", VECTORS["course_readiness"]))
def test_course_readiness(case):
    actual = course_readiness(case["cards"], NOW)
    assert actual == pytest.approx(case["expected"], abs=TOLERANCE)


def test_update_memory_state_does_not_mutate_its_input():
    progress = {"mastery": 0.5, "stability_days": 0.25, "last_reviewed_at": None}
    before = dict(progress)
    update_memory_state(progress, "right", NOW)
    assert progress == before


def test_right_answer_raises_both_values_and_wrong_lowers_them():
    progress = {"mastery": 0.5, "stability_days": 1.0, "last_reviewed_at": None}
    better = update_memory_state(progress, "right", NOW)
    worse = update_memory_state(progress, "wrong", NOW)
    assert better["mastery"] > progress["mastery"]
    assert better["stability_days"] > progress["stability_days"]
    assert worse["mastery"] < progress["mastery"]
    assert worse["stability_days"] < progress["stability_days"]


def test_memory_state_stays_inside_its_clamps_under_repeated_answers():
    progress = {"mastery": 0.5, "stability_days": 0.25, "last_reviewed_at": None}
    for _ in range(200):
        progress = {**update_memory_state(progress, "right", NOW), "last_reviewed_at": NOW.isoformat()}
    assert progress["mastery"] <= 0.98
    assert progress["stability_days"] <= 120.0
    for _ in range(200):
        progress = {**update_memory_state(progress, "wrong", NOW), "last_reviewed_at": NOW.isoformat()}
    assert progress["mastery"] >= 0.05
    assert progress["stability_days"] >= 0.02
