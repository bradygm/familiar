"""Structural guarantees for adaptive selection.

`adaptive_cards` is randomised by design, so it is tested for the properties
the product actually promises rather than for an exact card order.
"""

import random
from datetime import datetime, timezone

from backend.app.study import adaptive_cards, predicted_recall, selection_score

NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)


def card(card_id, seen_count=0, mastery=0.5, stability_days=0.25, last_reviewed_at=None):
    return {
        "id": card_id,
        "seen_count": seen_count,
        "mastery": mastery,
        "stability_days": stability_days,
        "last_reviewed_at": last_reviewed_at,
    }


def strong(card_id):
    return card(card_id, seen_count=12, mastery=0.98, stability_days=120.0, last_reviewed_at=NOW.isoformat())


def weak(card_id):
    return card(card_id, seen_count=4, mastery=0.1, stability_days=0.04, last_reviewed_at="2026-01-01T12:00:00+00:00")


def test_returns_every_card_when_the_course_is_smaller_than_the_limit():
    cards = [card(f"c{index}") for index in range(5)]
    selected = adaptive_cards(cards, 15, NOW)
    assert sorted(item["id"] for item in selected) == sorted(item["id"] for item in cards)


def test_respects_the_limit_and_never_repeats_a_card():
    cards = [card(f"c{index}", seen_count=index % 4) for index in range(60)]
    selected = adaptive_cards(cards, 15, NOW)
    assert len(selected) == 15
    assert len({item["id"] for item in selected}) == 15


def test_no_card_is_excluded_for_not_being_due():
    """The product promise: every card stays reachable, so repeated sessions
    over a well-known course still eventually surface every person."""
    cards = [strong(f"s{index}") for index in range(40)]
    random.seed(11)
    reached = set()
    for _ in range(200):
        reached.update(item["id"] for item in adaptive_cards(cards, 10, NOW))
    assert reached == {item["id"] for item in cards}


def test_weak_cards_dominate_a_session_over_strong_ones():
    cards = [weak(f"w{index}") for index in range(10)] + [strong(f"s{index}") for index in range(40)]
    random.seed(7)
    weak_share = []
    for _ in range(40):
        selected = adaptive_cards(cards, 15, NOW)
        weak_share.append(sum(item["id"].startswith("w") for item in selected))
    # 80% of each session is drawn from the top-scoring cards, so all ten weak
    # cards should almost always be present.
    assert min(weak_share) >= 9
    assert sum(weak_share) / len(weak_share) > 9.5


def test_unseen_cards_outrank_equally_recalled_seen_cards():
    recall = 0.5
    assert selection_score(0, recall) > selection_score(5, recall)


def test_lower_predicted_recall_outranks_higher():
    assert selection_score(5, 0.1) > selection_score(5, 0.9)


def test_a_long_gap_since_review_raises_a_card_score_through_recall_decay():
    fresh = predicted_recall(0.9, 7.0, 0.0)
    stale = predicted_recall(0.9, 7.0, 30.0)
    assert selection_score(5, stale) > selection_score(5, fresh)
