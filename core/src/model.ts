/**
 * The learning model: how well a person is known, and how fast that fades.
 *
 * Every value here is a pure function of stored numbers, so this module is the
 * single definition of what a learner's `mastery` and `stability_days` mean.
 * Its behaviour is pinned by `tests/fixtures/study_vectors.json`, which is
 * generated from the Python implementation this replaces — the parity suite in
 * `core/tests/golden.test.ts` is what makes the two interchangeable rather
 * than merely similar.
 *
 * Coefficients are deliberately simple product choices, not calibrated
 * probabilities. See README for the research they are inspired by, and
 * PROJECT_PLAN for the intent to calibrate them against real review data.
 */

import { daysSince } from './time.js';

/** The progress fields the model reads, named as the API returns them. */
export interface CardProgress {
  readonly seen_count: number;
  readonly mastery: number;
  readonly stability_days: number;
  readonly last_reviewed_at: string | null;
}

export interface MemoryState {
  readonly mastery: number;
  readonly stability_days: number;
}

export type ReviewResult = 'right' | 'wrong';

/** Predicted recall is reported inside this range, never as 0 or 1. */
export const MIN_RECALL = 0.01;
export const MAX_RECALL = 0.99;

/** Stability floor, in days. Also guards the division in `predictedRecall`. */
export const MIN_STABILITY_DAYS = 0.02;
export const MAX_STABILITY_DAYS = 120;

export const MIN_MASTERY = 0.05;
export const MAX_MASTERY = 0.98;

/** A card is "familiar" once seen at least once and at this mastery. */
export const FAMILIAR_MASTERY = 0.75;

/**
 * Chance of naming this person right now.
 *
 * Mastery decays exponentially with time since the last review, at a rate set
 * by the card's own stability. Clamped away from certainty at both ends.
 */
export function predictedRecall(
  mastery: number,
  stabilityDays: number,
  daysSinceReview: number,
): number {
  const decayed = mastery * Math.exp(-daysSinceReview / Math.max(stabilityDays, MIN_STABILITY_DAYS));
  return Math.max(MIN_RECALL, Math.min(MAX_RECALL, decayed));
}

/** Predicted recall for a stored progress row. */
export function cardPredictedRecall(
  progress: CardProgress,
  now: string | number | Date,
): number {
  return predictedRecall(
    progress.mastery,
    progress.stability_days,
    daysSince(progress.last_reviewed_at, now),
  );
}

/**
 * Rank a card for adaptive selection. Higher means more worth showing.
 *
 * Pure and jitter-injected: the caller supplies the randomness that breaks
 * ties between comparable cards, so the ranking itself can be asserted exactly.
 */
export function selectionScore(seenCount: number, recall: number, jitter = 0): number {
  const uncertainty = 1 / Math.sqrt(seenCount + 1);
  return (seenCount === 0 ? 2.2 : 0) + 3.0 * (1 - recall) + 0.55 * uncertainty + jitter;
}

/**
 * Average chance of naming a uniformly chosen person in a course right now.
 *
 * An unseen card contributes 0 rather than its prior, so the figure reads as
 * "how much of this roster do I actually know" instead of being flattered by
 * cards that have never been tested.
 */
export function courseReadiness(cards: readonly CardProgress[], at: string | number | Date): number {
  if (cards.length === 0) return 0;
  let total = 0;
  for (const card of cards) {
    total += card.seen_count === 0 ? 0 : cardPredictedRecall(card, at);
  }
  return total / cards.length;
}

/**
 * Update stored mastery and stability after an attempted retrieval.
 *
 * A successful retrieval that was *unlikely* to succeed teaches more than an
 * easy one, so both updates scale with how surprising the outcome was. A miss
 * cuts both values by a fixed proportion, harder than a hit raises them —
 * forgetting is treated as stronger evidence than remembering.
 *
 * Returns new values; the input is not modified.
 */
export function updateMemoryState(
  progress: CardProgress | (MemoryState & { last_reviewed_at: string | null }),
  result: ReviewResult,
  reviewedAt: string | number | Date,
): MemoryState {
  const mastery = Number(progress.mastery);
  const stability = Math.max(MIN_STABILITY_DAYS, Number(progress.stability_days));
  const recall = predictedRecall(mastery, stability, daysSince(progress.last_reviewed_at, reviewedAt));

  if (result === 'right') {
    return {
      mastery: Math.min(MAX_MASTERY, mastery + (1 - mastery) * (0.22 + 0.18 * (1 - recall))),
      stability_days: Math.min(MAX_STABILITY_DAYS, stability * (1.45 + 0.7 * (1 - recall)) + 0.03),
    };
  }
  return {
    mastery: Math.max(MIN_MASTERY, mastery * 0.55),
    stability_days: Math.max(MIN_STABILITY_DAYS, stability * 0.42),
  };
}

/** Where a card sits in the learner's progression, for display. */
export function learningStatus(progress: CardProgress): 'new' | 'learning' | 'familiar' {
  if (progress.seen_count === 0) return 'new';
  return progress.mastery >= FAMILIAR_MASTERY ? 'familiar' : 'learning';
}

export interface CourseSummary {
  /** Average chance of naming a uniformly chosen person, as a percentage. */
  readonly readiness: number;
  /** Share of the roster that is seen and at or above the familiar threshold. */
  readonly familiarPercent: number;
  readonly distribution: { new: number; learning: number; familiar: number };
}

/**
 * Everything the course and home screens report about a roster.
 *
 * Kept here rather than in the UI so the browser build and the local build
 * describe a course identically, and so "familiar" has one definition.
 */
export function summariseCourse(
  cards: readonly CardProgress[],
  at: string | number | Date,
): CourseSummary {
  const distribution = { new: 0, learning: 0, familiar: 0 };
  for (const card of cards) distribution[learningStatus(card)] += 1;
  const percent = (count: number) => (cards.length === 0 ? 0 : Math.round((count / cards.length) * 100));
  return {
    readiness: Math.round(courseReadiness(cards, at) * 100),
    familiarPercent: percent(distribution.familiar),
    distribution,
  };
}
