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
import { cardPredictedRecall, selectionScore, updateMemoryState } from './model.js';
/** Intervening reviews before a card in the cycle comes back. */
const MISS_GAP = 2;
const RECALL_GAPS = [3, 7];
/** Consecutive recalls that retire a card from the cycle. */
const RECALLS_TO_RETIRE = 3;
/** How much randomness separates cards of comparable score. */
const JITTER = 0.25;
/**
 * A never-ending adaptive session.
 *
 * Holds its own copy of each card's memory state and updates it in place, so
 * ranking always reflects answers given moments ago rather than the state the
 * session started with.
 */
export class ContinuousSession {
    cards;
    random;
    avoidRecent;
    cycles = new Map();
    recent = [];
    reviewCount = 0;
    recoveredCount = 0;
    currentCard = null;
    currentFromCycle = false;
    constructor(cards, options = {}) {
        if (cards.length === 0)
            throw new Error('A continuous session needs at least one card.');
        // Copied so the caller's objects are not mutated by scoring.
        this.cards = cards.map((card) => ({ ...card }));
        this.random = options.random ?? Math.random;
        this.avoidRecent = Math.max(0, Math.min(options.avoidRecent ?? 3, this.cards.length - 1));
    }
    get current() {
        return this.currentCard;
    }
    get stats() {
        return { reviews: this.reviewCount, queued: this.cycles.size, recovered: this.recoveredCount };
    }
    /** True when the current card is being revisited as part of a cycle. */
    get currentIsRevisit() {
        return this.currentFromCycle;
    }
    /** Choose the next person to show. Never returns null; the session has no end. */
    next(now = Date.now()) {
        const due = this.dueFromCycle();
        if (due) {
            this.currentCard = due;
            this.currentFromCycle = true;
            return due;
        }
        this.currentCard = this.highestScoring(now);
        this.currentFromCycle = false;
        return this.currentCard;
    }
    /**
     * Record an answer for the current card and advance its cycle.
     *
     * Returns the new memory state so the caller can persist it; the session has
     * already applied it to its own copy.
     */
    record(result, at = Date.now()) {
        const card = this.currentCard;
        if (!card)
            throw new Error('Call next() before recording a result.');
        const memory = updateMemoryState(card, result, at);
        Object.assign(card, memory, {
            last_reviewed_at: typeof at === 'string' ? at : new Date(at).toISOString(),
            seen_count: card.seen_count + 1,
        });
        this.reviewCount += 1;
        this.recent.push(card.id);
        while (this.recent.length > this.avoidRecent)
            this.recent.shift();
        const entry = this.cycles.get(card.id);
        if (result === 'wrong') {
            // A miss always restarts the cycle, whether or not it was already in one.
            this.cycles.set(card.id, { readyAt: this.reviewCount + MISS_GAP, recalls: 0 });
        }
        else if (entry) {
            const recalls = entry.recalls + 1;
            if (recalls >= RECALLS_TO_RETIRE) {
                this.cycles.delete(card.id);
                this.recoveredCount += 1;
            }
            else {
                this.cycles.set(card.id, { readyAt: this.reviewCount + RECALL_GAPS[recalls - 1], recalls });
            }
        }
        return { card, memory };
    }
    dueFromCycle() {
        let bestId = null;
        let bestReadyAt = Infinity;
        for (const [id, entry] of this.cycles) {
            if (entry.readyAt <= this.reviewCount && entry.readyAt < bestReadyAt) {
                bestId = id;
                bestReadyAt = entry.readyAt;
            }
        }
        return this.byId(bestId);
    }
    byId(id) {
        if (id === null)
            return null;
        return this.cards.find((card) => card.id === id) ?? null;
    }
    highestScoring(now) {
        const avoid = new Set(this.recent);
        let best = null;
        let bestScore = -Infinity;
        for (const card of this.cards) {
            if (avoid.has(card.id))
                continue;
            const score = selectionScore(card.seen_count, cardPredictedRecall(card, now), this.random() * JITTER);
            if (score > bestScore) {
                bestScore = score;
                best = card;
            }
        }
        // Only reachable if every card was recently shown, which the avoidRecent
        // clamp prevents; fall back rather than returning nothing.
        return best ?? this.cards[Math.floor(this.random() * this.cards.length)];
    }
}
//# sourceMappingURL=continuous.js.map