/**
 * Ordering a roster.
 *
 * Every ordering that depends on the learning model lives here, so the browser
 * build and the local build rank people identically and "hardest" means one
 * thing. Name ordering is included too, so a caller has a single entry point
 * rather than some sorts hitting the database and others not.
 */

import { cardPredictedRecall, learningDifficulty, type CardHistory } from './model.js';

export type RosterSort = 'first' | 'last' | 'recall' | 'difficulty' | 'strength';

export interface RosterCard extends CardHistory {
  readonly first_name: string;
  readonly last_name: string;
}

const byName = (left: RosterCard, right: RosterCard) =>
  left.last_name.localeCompare(right.last_name) || left.first_name.localeCompare(right.first_name);

/**
 * Sort a roster without modifying the caller's array.
 *
 * `recall` and `strength` both put the weakest first, because the point of
 * those views is to find who needs attention. They differ in whether time
 * counts: strength is the stored estimate, recall is that estimate decayed by
 * how long it has been. `difficulty` puts the hardest-won people first.
 */
export function sortRoster<T extends RosterCard>(
  cards: readonly T[],
  sort: RosterSort,
  now: string | number | Date = Date.now(),
): T[] {
  const sorted = cards.slice();
  switch (sort) {
    case 'first':
      return sorted.sort(
        (left, right) =>
          left.first_name.localeCompare(right.first_name) || left.last_name.localeCompare(right.last_name),
      );
    case 'last':
      return sorted.sort(byName);
    case 'recall':
      return sorted.sort(
        (left, right) => cardPredictedRecall(left, now) - cardPredictedRecall(right, now) || left.seen_count - right.seen_count || byName(left, right),
      );
    case 'strength':
      return sorted.sort((left, right) => left.mastery - right.mastery || left.seen_count - right.seen_count || byName(left, right));
    case 'difficulty':
      return sorted.sort(
        (left, right) => learningDifficulty(right) - learningDifficulty(left) || right.wrong_count - left.wrong_count || byName(left, right),
      );
  }
}
