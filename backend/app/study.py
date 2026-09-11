import math
import random
from datetime import datetime, timezone
from typing import Dict, List, Optional


def days_since(timestamp: Optional[str], now: datetime) -> float:
    if not timestamp:
        return 365.0
    reviewed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return max(0.0, (now - reviewed).total_seconds() / 86_400)


def predicted_recall(mastery: float, stability_days: float, days_since_review: float) -> float:
    return max(0.01, min(0.99, mastery * math.exp(-days_since_review / max(stability_days, 0.02))))


def course_readiness(cards: List[dict], at: datetime) -> float:
    """Estimate the chance of naming a uniformly chosen person in a course now."""
    if not cards:
        return 0.0
    recalls = [
        0.0
        if card["seen_count"] == 0
        else predicted_recall(card["mastery"], card["stability_days"], days_since(card["last_reviewed_at"], at))
        for card in cards
    ]
    return sum(recalls) / len(recalls)


def selection_score(seen_count: int, recall: float, jitter: float = 0.0) -> float:
    """Rank a card for adaptive selection. Higher means more worth showing.

    Kept pure and jitter-injected so the ranking can be verified exactly; the
    caller supplies the randomness that breaks ties between similar cards.
    """
    uncertainty = 1 / math.sqrt(seen_count + 1)
    return (2.2 if seen_count == 0 else 0) + 3.0 * (1 - recall) + 0.55 * uncertainty + jitter


def adaptive_cards(cards: List[dict], limit: int, now: Optional[datetime] = None) -> List[dict]:
    """Select a useful mix; cards are never excluded for being not due."""
    now = now or datetime.now(timezone.utc)
    if len(cards) <= limit:
        selected = cards[:]
        random.shuffle(selected)
        return selected

    scored = []
    for card in cards:
        seen = card["seen_count"]
        recall = predicted_recall(card["mastery"], card["stability_days"], days_since(card["last_reviewed_at"], now))
        score = selection_score(seen, recall, random.random() * 0.25)
        scored.append((score, card))

    scored.sort(key=lambda item: item[0], reverse=True)
    weak_count = max(1, round(limit * 0.8))
    selected = [card for _, card in scored[:weak_count]]
    remainder = [card for _, card in scored[weak_count:]]
    if remainder:
        selected.extend(random.sample(remainder, min(limit - len(selected), len(remainder))))
    random.shuffle(selected)
    return selected


def update_memory_state(progress: dict, result: str, reviewed_at: datetime) -> Dict[str, float]:
    """Update persistent mastery and stability after an attempted retrieval."""
    mastery = float(progress["mastery"])
    stability = max(0.02, float(progress["stability_days"]))
    recall = predicted_recall(mastery, stability, days_since(progress["last_reviewed_at"], reviewed_at))
    if result == "right":
        next_mastery = min(0.98, mastery + (1 - mastery) * (0.22 + 0.18 * (1 - recall)))
        next_stability = min(120.0, stability * (1.45 + 0.7 * (1 - recall)) + 0.03)
    else:
        next_mastery = max(0.05, mastery * 0.55)
        next_stability = max(0.02, stability * 0.42)
    return {"mastery": next_mastery, "stability_days": next_stability}
