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
export declare const MIN_RECALL = 0.01;
export declare const MAX_RECALL = 0.99;
/** Stability floor, in days. Also guards the division in `predictedRecall`. */
export declare const MIN_STABILITY_DAYS = 0.02;
export declare const MAX_STABILITY_DAYS = 120;
export declare const MIN_MASTERY = 0.05;
export declare const MAX_MASTERY = 0.98;
/** A card is "familiar" once seen at least once and at this mastery. */
export declare const FAMILIAR_MASTERY = 0.75;
/**
 * Chance of naming this person right now.
 *
 * Mastery decays exponentially with time since the last review, at a rate set
 * by the card's own stability. Clamped away from certainty at both ends.
 */
export declare function predictedRecall(mastery: number, stabilityDays: number, daysSinceReview: number): number;
/** Predicted recall for a stored progress row. */
export declare function cardPredictedRecall(progress: CardProgress, now: string | number | Date): number;
/**
 * Rank a card for adaptive selection. Higher means more worth showing.
 *
 * Pure and jitter-injected: the caller supplies the randomness that breaks
 * ties between comparable cards, so the ranking itself can be asserted exactly.
 */
export declare function selectionScore(seenCount: number, recall: number, jitter?: number): number;
/**
 * Average chance of naming a uniformly chosen person in a course right now.
 *
 * An unseen card contributes 0 rather than its prior, so the figure reads as
 * "how much of this roster do I actually know" instead of being flattered by
 * cards that have never been tested.
 */
export declare function courseReadiness(cards: readonly CardProgress[], at: string | number | Date): number;
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
export declare function updateMemoryState(progress: CardProgress | (MemoryState & {
    last_reviewed_at: string | null;
}), result: ReviewResult, reviewedAt: string | number | Date): MemoryState;
/** Where a card sits in the learner's progression, for display. */
export declare function learningStatus(progress: CardProgress): 'new' | 'learning' | 'familiar';
export interface CourseSummary {
    /** Average chance of naming a uniformly chosen person, as a percentage. */
    readonly readiness: number;
    /** Share of the roster that is seen and at or above the familiar threshold. */
    readonly familiarPercent: number;
    readonly distribution: {
        new: number;
        learning: number;
        familiar: number;
    };
}
/**
 * Everything the course and home screens report about a roster.
 *
 * Kept here rather than in the UI so the browser build and the local build
 * describe a course identically, and so "familiar" has one definition.
 */
export declare function summariseCourse(cards: readonly CardProgress[], at: string | number | Date): CourseSummary;
/** Progress plus the running tallies the roster views sort on. */
export interface CardHistory extends CardProgress {
    readonly right_count: number;
    readonly wrong_count: number;
}
/** Damping on the difficulty estimate, in notional extra correct sightings. */
export declare const DIFFICULTY_SMOOTHING = 3;
/**
 * How much trouble a person has given the learner. Higher is harder.
 *
 * Misses per sighting, damped so that thin evidence reads as "not known to be
 * hard" rather than as hard. A raw miss rate is far too jumpy to sort by — one
 * miss out of two sightings would score 0.5 and outrank someone missed twelve
 * times in forty. Damping toward zero also puts people who have never been
 * studied at the bottom, which is the honest place for them: how hard someone
 * was to learn is not a question their record can answer yet.
 *
 * The figure rises both with the miss rate and with the sheer number of
 * misses, so a person missed ten times in twenty ranks above one missed five
 * times in ten. That matches what the ordering is for: finding who actually
 * cost effort.
 */
export declare function learningDifficulty(history: CardHistory): number;
//# sourceMappingURL=model.d.ts.map