/**
 * Cross-language parity: this TypeScript model must reproduce the Python one.
 *
 * The vectors are read from the very same file `tests/test_study_golden.py`
 * asserts against, generated from the Python implementation. That shared
 * fixture is the whole point — it turns "the port looks right" into "the port
 * produces identical numbers on 626 cases, including the microsecond
 * timestamps that real data actually contains".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  courseReadiness,
  daysSince,
  predictedRecall,
  selectionScore,
  updateMemoryState,
  type CardProgress,
} from '../src/index.js';

interface Vectors {
  schema: number;
  now: string;
  source_commit: string;
  days_since: { timestamp: string | null; expected: number }[];
  predicted_recall: { mastery: number; stability_days: number; days_since_review: number; expected: number }[];
  selection_score: { seen_count: number; recall: number; expected: number }[];
  update_memory_state: {
    progress: { mastery: number; stability_days: number; last_reviewed_at: string | null };
    result: 'right' | 'wrong';
    reviewed_at: string;
    expected: { mastery: number; stability_days: number };
  }[];
  course_readiness: { cards: CardProgress[]; expected: number }[];
}

const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/study_vectors.json', import.meta.url));
const vectors: Vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/**
 * Tight enough that a changed coefficient fails, loose enough to absorb the
 * last-bit difference between Python's libm `exp` and V8's, which the
 * ECMAScript spec explicitly permits to be implementation-defined.
 */
const TOLERANCE = 1e-12;

it('reads the expected fixture schema', () => {
  expect(vectors.schema).toBe(1);
  expect(vectors.days_since.length).toBeGreaterThan(0);
});

describe('daysSince', () => {
  it.each(vectors.days_since.map((c, index) => [index, c] as const))(
    'case %i: %o',
    (_index, testCase) => {
      expect(daysSince(testCase.timestamp, vectors.now)).toBeCloseTo(testCase.expected, 12);
    },
  );

  it('preserves microseconds rather than truncating to milliseconds', () => {
    // The difference a naive `new Date(...)` would throw away.
    const precise = daysSince('2026-08-30T02:47:04.671168+00:00', '2026-08-31T02:47:04.671168+00:00');
    const truncated = daysSince('2026-08-30T02:47:04.671000+00:00', '2026-08-31T02:47:04.671168+00:00');
    expect(precise).toBe(1);
    expect(truncated).toBeGreaterThan(1);
    expect(truncated - precise).toBeCloseTo(1.68e-4 / 86_400, 15);
  });
});

describe('predictedRecall', () => {
  it.each(vectors.predicted_recall.map((c, index) => [index, c] as const))(
    'case %i',
    (_index, testCase) => {
      const actual = predictedRecall(testCase.mastery, testCase.stability_days, testCase.days_since_review);
      expect(Math.abs(actual - testCase.expected)).toBeLessThan(TOLERANCE);
      expect(actual).toBeGreaterThanOrEqual(0.01);
      expect(actual).toBeLessThanOrEqual(0.99);
    },
  );
});

describe('selectionScore', () => {
  it.each(vectors.selection_score.map((c, index) => [index, c] as const))(
    'case %i',
    (_index, testCase) => {
      expect(Math.abs(selectionScore(testCase.seen_count, testCase.recall) - testCase.expected)).toBeLessThan(TOLERANCE);
    },
  );
});

describe('updateMemoryState', () => {
  it.each(vectors.update_memory_state.map((c, index) => [index, c] as const))(
    'case %i',
    (_index, testCase) => {
      const actual = updateMemoryState(testCase.progress, testCase.result, testCase.reviewed_at);
      expect(Math.abs(actual.mastery - testCase.expected.mastery)).toBeLessThan(TOLERANCE);
      expect(Math.abs(actual.stability_days - testCase.expected.stability_days)).toBeLessThan(TOLERANCE);
    },
  );

  it('does not modify its input', () => {
    const progress = { mastery: 0.5, stability_days: 0.25, last_reviewed_at: null };
    const snapshot = { ...progress };
    updateMemoryState(progress, 'right', vectors.now);
    expect(progress).toEqual(snapshot);
  });
});

describe('courseReadiness', () => {
  it.each(vectors.course_readiness.map((c, index) => [index, c] as const))(
    'case %i',
    (_index, testCase) => {
      expect(Math.abs(courseReadiness(testCase.cards, vectors.now) - testCase.expected)).toBeLessThan(TOLERANCE);
    },
  );
});
