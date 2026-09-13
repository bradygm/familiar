/**
 * Regenerate the golden vectors that pin the learning model's behaviour.
 *
 *     cd core && npm run vectors
 *
 * Run this ONLY to deliberately re-baseline the model. A diff in
 * `tests/fixtures/study_vectors.json` is then a reviewable statement that the
 * model changed, rather than an accident.
 *
 * The fixture in the repository was originally generated from the Python
 * implementation in `backend/app/study.py`, and the TypeScript core was
 * verified against it before that file was deleted. Re-running this replaces
 * that provenance with the current TypeScript behaviour, which is correct once
 * a change is intended — but it means the file no longer witnesses the port.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Imports the compiled output rather than src/, because Node's type stripping
// does not remap the .js specifiers the browser build needs. `npm run vectors`
// builds first, so this also exercises the artifact that actually ships.
import {
  courseReadiness,
  daysSince,
  predictedRecall,
  selectionScore,
  updateMemoryState,
  type CardProgress,
} from '../../frontend/vendor/core/index.js';

const NOW = '2026-03-01T12:00:00+00:00';
const NOW_MS = Date.parse(NOW);
const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/study_vectors.json', import.meta.url));

const MASTERY_VALUES = [0.05, 0.25, 0.5, 0.75, 0.9, 0.98];
const STABILITY_VALUES = [0.02, 0.04, 0.25, 1.0, 7.0, 30.0, 120.0];
const ELAPSED_DAYS = [0.0, 0.01, 0.5, 1.0, 3.0, 14.0, 365.0];
const SEEN_COUNTS = [0, 1, 2, 5, 20];

// Deliberately not whole milliseconds: stored timestamps carry microseconds, and
// a port that leans on `new Date(...)` must fail these rather than drift quietly.
const SUB_MILLISECOND_DAYS = [0.000000671168, 0.000008889861, 1.000000144057, 0.5 + 1e-9];

/**
 * Mirror Python's `datetime.fromtimestamp(...).isoformat()`.
 *
 * The arithmetic is done in seconds, not milliseconds, to match Python's
 * rounding. At epoch-millisecond magnitudes a double resolves only ~0.24
 * microseconds, so computing in milliseconds and scaling up rounds to a
 * different microsecond than Python does — a 1 microsecond difference, which
 * is 1.16e-11 days and enough to make a regenerated fixture disagree with the
 * committed one for no real reason. Python also omits the fractional part
 * entirely when it is zero.
 */
function iso(daysAgo: number): string {
  const totalSeconds = NOW_MS / 1000 - daysAgo * 86_400;
  const micros = Math.round(totalSeconds * 1e6);
  const wholeSeconds = Math.floor(micros / 1_000_000);
  const remainder = micros - wholeSeconds * 1_000_000;
  const base = new Date(wholeSeconds * 1000).toISOString().slice(0, 19);
  const fraction = remainder === 0 ? '' : `.${String(remainder).padStart(6, '0')}`;
  return `${base}${fraction}+00:00`;
}

const vectors = {
  schema: 1,
  now: NOW,
  source_commit: 'regenerated from core/ — see core/scripts/generate-vectors.ts',
  days_since: [
    { timestamp: null, expected: daysSince(null, NOW) },
    ...[...ELAPSED_DAYS, ...SUB_MILLISECOND_DAYS].map((days) => ({
      timestamp: iso(days),
      expected: daysSince(iso(days), NOW),
    })),
    { timestamp: '2026-02-28T12:00:00Z', expected: daysSince('2026-02-28T12:00:00Z', NOW) },
    { timestamp: '2026-02-28T05:00:00-07:00', expected: daysSince('2026-02-28T05:00:00-07:00', NOW) },
    { timestamp: iso(-5.0), expected: daysSince(iso(-5.0), NOW) },
  ],
  predicted_recall: MASTERY_VALUES.flatMap((mastery) =>
    STABILITY_VALUES.flatMap((stability) =>
      ELAPSED_DAYS.map((elapsed) => ({
        mastery,
        stability_days: stability,
        days_since_review: elapsed,
        expected: predictedRecall(mastery, stability, elapsed),
      })),
    ),
  ),
  selection_score: SEEN_COUNTS.flatMap((seen) =>
    [0.01, 0.2, 0.5, 0.8, 0.99].map((recall) => ({
      seen_count: seen,
      recall,
      expected: selectionScore(seen, recall),
    })),
  ),
  update_memory_state: MASTERY_VALUES.flatMap((mastery) =>
    [0.02, 0.25, 1.0, 30.0].flatMap((stability) =>
      [null, 0.0, 1.0, 14.0, 0.000000671168, 0.25 + 3e-10].flatMap((elapsed) =>
        (['right', 'wrong'] as const).map((result) => {
          const progress = {
            mastery,
            stability_days: stability,
            last_reviewed_at: elapsed === null ? null : iso(elapsed),
          };
          return { progress, result, reviewed_at: NOW, expected: updateMemoryState(progress, result, NOW) };
        }),
      ),
    ),
  ),
  course_readiness: (
    [
      [],
      [{ seen_count: 0, mastery: 0.5, stability_days: 0.25, last_reviewed_at: null }],
      [
        { seen_count: 3, mastery: 0.9, stability_days: 7.0, last_reviewed_at: iso(1.0) },
        { seen_count: 0, mastery: 0.5, stability_days: 0.25, last_reviewed_at: null },
        { seen_count: 1, mastery: 0.3, stability_days: 0.25, last_reviewed_at: iso(14.0) },
      ],
      Array.from({ length: 4 }, () => ({
        seen_count: 10,
        mastery: 0.98,
        stability_days: 120.0,
        last_reviewed_at: iso(0.0),
      })),
    ] as CardProgress[][]
  ).map((cards) => ({ cards, expected: courseReadiness(cards, NOW) })),
};

const target = process.argv[2] ?? FIXTURE;
writeFileSync(target, JSON.stringify(vectors, null, 2) + '\n');
const counts = Object.fromEntries(
  Object.entries(vectors).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length]),
);
console.log(`wrote ${target}`);
console.log(`vectors: ${JSON.stringify(counts)}`);
