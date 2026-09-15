/**
 * Choosing what to study.
 *
 * The product promise is that a session is never gated: there are no due
 * dates, nothing is ever unavailable, and starting a session always produces a
 * useful mixture. Selection therefore ranks every card and samples from that
 * ranking, rather than filtering on eligibility.
 */
import { type CardProgress } from './model.js';
/** Injectable so selection can be tested deterministically. */
export type Random = () => number;
export interface AdaptiveOptions {
    readonly now?: string | number | Date;
    readonly random?: Random;
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
export declare function adaptiveCards<T extends CardProgress>(cards: readonly T[], limit: number, options?: AdaptiveOptions): T[];
//# sourceMappingURL=selection.d.ts.map