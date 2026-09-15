/**
 * Ordering a roster.
 *
 * Every ordering that depends on the learning model lives here, so the browser
 * build and the local build rank people identically and "hardest" means one
 * thing. Name ordering is included too, so a caller has a single entry point
 * rather than some sorts hitting the database and others not.
 */
import { type CardHistory } from './model.js';
export type RosterSort = 'first' | 'last' | 'recall' | 'difficulty' | 'strength';
export interface RosterCard extends CardHistory {
    readonly first_name: string;
    readonly last_name: string;
}
/**
 * Sort a roster without modifying the caller's array.
 *
 * `recall` and `strength` both put the weakest first, because the point of
 * those views is to find who needs attention. They differ in whether time
 * counts: strength is the stored estimate, recall is that estimate decayed by
 * how long it has been. `difficulty` puts the hardest-won people first.
 */
export declare function sortRoster<T extends RosterCard>(cards: readonly T[], sort: RosterSort, now?: string | number | Date): T[];
//# sourceMappingURL=roster.d.ts.map