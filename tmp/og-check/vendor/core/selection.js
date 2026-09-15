/**
 * Choosing what to study.
 *
 * The product promise is that a session is never gated: there are no due
 * dates, nothing is ever unavailable, and starting a session always produces a
 * useful mixture. Selection therefore ranks every card and samples from that
 * ranking, rather than filtering on eligibility.
 */
import { cardPredictedRecall, selectionScore } from './model.js';
/** Fraction of a session drawn from the highest-scoring cards. */
const WEAK_SHARE = 0.8;
/** How much randomness separates cards with comparable scores. */
const JITTER = 0.25;
function shuffled(items, random) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
}
function sample(items, count, random) {
    return shuffled(items, random).slice(0, Math.max(0, count));
}
/**
 * Select a varied session.
 *
 * Most of the session comes from the weakest cards — unseen, poorly recalled,
 * or barely tested — and the remainder is sampled from everything else, so
 * well-known people still resurface and keep their estimates fresh. No card is
 * excluded for not being "due".
 *
 * The randomness means this does not reproduce the Python implementation card
 * for card, and is not expected to; the properties it guarantees are asserted
 * in `core/tests/selection.test.ts`.
 */
export function adaptiveCards(cards, limit, options = {}) {
    const random = options.random ?? Math.random;
    const now = options.now ?? Date.now();
    if (cards.length <= limit)
        return shuffled(cards, random);
    const scored = cards
        .map((card) => ({
        card,
        score: selectionScore(card.seen_count, cardPredictedRecall(card, now), random() * JITTER),
    }))
        .sort((left, right) => right.score - left.score);
    // `limit * WEAK_SHARE` can never land on an exact .5, so rounding direction
    // is not a parity concern between languages.
    const weakCount = Math.max(1, Math.round(limit * WEAK_SHARE));
    const selected = scored.slice(0, weakCount).map((entry) => entry.card);
    const remainder = scored.slice(weakCount).map((entry) => entry.card);
    if (remainder.length > 0) {
        selected.push(...sample(remainder, Math.min(limit - selected.length, remainder.length), random));
    }
    return shuffled(selected, random);
}
//# sourceMappingURL=selection.js.map