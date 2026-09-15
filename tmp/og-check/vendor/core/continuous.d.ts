/**
 * Continuous study: a session with no end.
 *
 * Adaptive review picks a set and stops. This keeps going, re-ranking after
 * every answer, so a long sitting stays useful instead of running out. The
 * important behaviour is what happens when you miss someone: rather than
 * waiting for the ranking to bring them back eventually, a miss puts that
 * person straight into an expanding-retrieval cycle — seen again soon, then at
 * widening gaps, until they have been recalled a few times running.
 *
 * The gaps mirror the capped expanding-recall mode: a miss returns after 2
 * intervening reviews, then correct recalls push it to 3 and 7 before the
 * person leaves the cycle. Unlike that mode there is no base set and no cap —
 * anyone you miss enters the cycle, and the session ends when you stop.
 */
import { type CardProgress, type MemoryState, type ReviewResult } from './model.js';
import type { Random } from './selection.js';
export interface ContinuousCard extends CardProgress {
    readonly id: string;
}
export interface ContinuousOptions {
    readonly random?: Random;
    /** How many recent people to avoid repeating. Clamped to the roster size. */
    readonly avoidRecent?: number;
}
export interface ContinuousStats {
    /** Answers given so far. */
    readonly reviews: number;
    /** People currently inside an expanding-retrieval cycle. */
    readonly queued: number;
    /** People who entered a cycle and have since been recalled enough to leave. */
    readonly recovered: number;
}
/**
 * A never-ending adaptive session.
 *
 * Holds its own copy of each card's memory state and updates it in place, so
 * ranking always reflects answers given moments ago rather than the state the
 * session started with.
 */
export declare class ContinuousSession<T extends ContinuousCard> {
    private readonly cards;
    private readonly random;
    private readonly avoidRecent;
    private readonly cycles;
    private readonly recent;
    private reviewCount;
    private recoveredCount;
    private currentCard;
    private currentFromCycle;
    constructor(cards: readonly T[], options?: ContinuousOptions);
    get current(): T | null;
    get stats(): ContinuousStats;
    /** True when the current card is being revisited as part of a cycle. */
    get currentIsRevisit(): boolean;
    /** Choose the next person to show. Never returns null; the session has no end. */
    next(now?: string | number | Date): T;
    /**
     * Record an answer for the current card and advance its cycle.
     *
     * Returns the new memory state so the caller can persist it; the session has
     * already applied it to its own copy.
     */
    record(result: ReviewResult, at?: string | number | Date): {
        card: T;
        memory: MemoryState;
    };
    private dueFromCycle;
    private byId;
    private highestScoring;
}
//# sourceMappingURL=continuous.d.ts.map