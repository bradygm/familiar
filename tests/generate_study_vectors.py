"""Regenerate the golden vectors that pin the learning model's behaviour.

Run this ONLY to deliberately re-baseline the model:

    .venv/bin/python tests/generate_study_vectors.py

A diff in `tests/fixtures/study_vectors.json` is then a deliberate,
reviewable statement that the learning model changed. The TypeScript core
is expected to reproduce this file exactly, which is what makes the port
verifiable rather than hopeful.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.app.study import (
    course_readiness,
    days_since,
    predicted_recall,
    selection_score,
    update_memory_state,
)

NOW = datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)
FIXTURE = Path(__file__).parent / "fixtures" / "study_vectors.json"

# Spread across the meaningful regions of the model: unseen cards, freshly
# learned cards, decayed cards, and the clamp boundaries.
MASTERY_VALUES = [0.05, 0.25, 0.5, 0.75, 0.9, 0.98]
STABILITY_VALUES = [0.02, 0.04, 0.25, 1.0, 7.0, 30.0, 120.0]
ELAPSED_DAYS = [0.0, 0.01, 0.5, 1.0, 3.0, 14.0, 365.0]

# Every stored timestamp carries microseconds, because the app writes
# `datetime.now(timezone.utc).isoformat()`. JavaScript's Date only resolves
# milliseconds, so the TypeScript port has to parse fractional seconds itself.
# These offsets are deliberately not whole milliseconds, so a port that leans
# on `new Date(...)` fails the parity suite instead of drifting quietly.
SUB_MILLISECOND_DAYS = [
    0.000_000_671_168,
    0.000_008_889_861,
    1.000_000_144_057,
    0.5 + 1e-9,
]
SEEN_COUNTS = [0, 1, 2, 5, 20]


def iso(days_ago: float) -> str:
    return datetime.fromtimestamp(NOW.timestamp() - days_ago * 86_400, tz=timezone.utc).isoformat()


def main() -> None:
    vectors = {
        "schema": 1,
        "now": NOW.isoformat(),
        "source_commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True
        ).stdout.strip(),
        "days_since": [
            {"timestamp": None, "expected": days_since(None, NOW)},
            *[
                {"timestamp": iso(days), "expected": days_since(iso(days), NOW)}
                for days in ELAPSED_DAYS + SUB_MILLISECOND_DAYS
            ],
            # Trailing-Z timestamps must parse the same as offset timestamps.
            {"timestamp": "2026-02-28T12:00:00Z", "expected": days_since("2026-02-28T12:00:00Z", NOW)},
            # A non-UTC offset must be honoured, not ignored.
            {"timestamp": "2026-02-28T05:00:00-07:00", "expected": days_since("2026-02-28T05:00:00-07:00", NOW)},
            # A future timestamp clamps to zero rather than going negative.
            {"timestamp": iso(-5.0), "expected": days_since(iso(-5.0), NOW)},
        ],
        "predicted_recall": [
            {
                "mastery": mastery,
                "stability_days": stability,
                "days_since_review": elapsed,
                "expected": predicted_recall(mastery, stability, elapsed),
            }
            for mastery in MASTERY_VALUES
            for stability in STABILITY_VALUES
            for elapsed in ELAPSED_DAYS
        ],
        "selection_score": [
            {
                "seen_count": seen,
                "recall": recall,
                "expected": selection_score(seen, recall),
            }
            for seen in SEEN_COUNTS
            for recall in [0.01, 0.2, 0.5, 0.8, 0.99]
        ],
        "update_memory_state": [
            {
                "progress": {
                    "mastery": mastery,
                    "stability_days": stability,
                    "last_reviewed_at": None if elapsed is None else iso(elapsed),
                },
                "result": result,
                "reviewed_at": NOW.isoformat(),
                "expected": update_memory_state(
                    {
                        "mastery": mastery,
                        "stability_days": stability,
                        "last_reviewed_at": None if elapsed is None else iso(elapsed),
                    },
                    result,
                    NOW,
                ),
            }
            for mastery in MASTERY_VALUES
            for stability in [0.02, 0.25, 1.0, 30.0]
            for elapsed in [None, 0.0, 1.0, 14.0, 0.000_000_671_168, 0.25 + 3e-10]
            for result in ("right", "wrong")
        ],
        "course_readiness": [],
    }

    readiness_cases = [
        [],
        [{"seen_count": 0, "mastery": 0.5, "stability_days": 0.25, "last_reviewed_at": None}],
        [
            {"seen_count": 3, "mastery": 0.9, "stability_days": 7.0, "last_reviewed_at": iso(1.0)},
            {"seen_count": 0, "mastery": 0.5, "stability_days": 0.25, "last_reviewed_at": None},
            {"seen_count": 1, "mastery": 0.3, "stability_days": 0.25, "last_reviewed_at": iso(14.0)},
        ],
        [
            {"seen_count": 10, "mastery": 0.98, "stability_days": 120.0, "last_reviewed_at": iso(0.0)}
            for _ in range(4)
        ],
    ]
    vectors["course_readiness"] = [
        {"cards": cards, "expected": course_readiness(cards, NOW)} for cards in readiness_cases
    ]

    FIXTURE.write_text(json.dumps(vectors, indent=2) + "\n")
    counts = {key: len(value) for key, value in vectors.items() if isinstance(value, list)}
    print(f"wrote {FIXTURE}")
    print(f"vectors: {counts}  total={sum(counts.values())}")


if __name__ == "__main__":
    main()
