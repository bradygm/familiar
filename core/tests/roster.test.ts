/** Roster ordering, including the two new "who needs work" views. */

import { describe, expect, it } from 'vitest';

import { learningDifficulty, sortRoster, type RosterCard } from '../src/index.js';

const NOW = '2026-03-01T12:00:00+00:00';

function person(overrides: Partial<RosterCard> & { first_name: string; last_name: string }): RosterCard {
  return {
    seen_count: 0,
    right_count: 0,
    wrong_count: 0,
    mastery: 0.5,
    stability_days: 0.25,
    last_reviewed_at: null,
    ...overrides,
  };
}

describe('learningDifficulty', () => {
  it('rates somebody missed often above somebody missed rarely', () => {
    const stubborn = person({ first_name: 'A', last_name: 'A', seen_count: 20, wrong_count: 12, right_count: 8 });
    const easy = person({ first_name: 'B', last_name: 'B', seen_count: 20, wrong_count: 1, right_count: 19 });
    expect(learningDifficulty(stubborn)).toBeGreaterThan(learningDifficulty(easy));
  });

  it('does not let a single miss out of two sightings outrank a long hard record', () => {
    // The reason the estimate is damped rather than raw: a raw miss rate puts
    // the barely-seen person at 0.5, above a genuinely difficult 0.3 record.
    const barelySeen = person({ first_name: 'A', last_name: 'A', seen_count: 2, wrong_count: 1, right_count: 1 });
    const longRecord = person({ first_name: 'B', last_name: 'B', seen_count: 40, wrong_count: 12, right_count: 28 });
    expect(learningDifficulty(longRecord)).toBeGreaterThan(learningDifficulty(barelySeen));
  });

  it('treats an unstudied person as not known to be hard', () => {
    const unseen = person({ first_name: 'A', last_name: 'A' });
    const hard = person({ first_name: 'B', last_name: 'B', seen_count: 20, wrong_count: 18, right_count: 2 });
    expect(learningDifficulty(unseen)).toBe(0);
    expect(learningDifficulty(unseen)).toBeLessThan(learningDifficulty(hard));
  });

  it('rises with the number of misses, not only the rate', () => {
    const manyMisses = person({ first_name: 'A', last_name: 'A', seen_count: 20, wrong_count: 10, right_count: 10 });
    const fewerMisses = person({ first_name: 'B', last_name: 'B', seen_count: 10, wrong_count: 5, right_count: 5 });
    expect(learningDifficulty(manyMisses)).toBeGreaterThan(learningDifficulty(fewerMisses));
  });
});

describe('sortRoster', () => {
  const people = [
    person({ first_name: 'Zoe', last_name: 'Adams', seen_count: 10, right_count: 9, wrong_count: 1, mastery: 0.95, stability_days: 40, last_reviewed_at: NOW }),
    person({ first_name: 'Adam', last_name: 'Zhao', seen_count: 10, right_count: 3, wrong_count: 7, mastery: 0.2, stability_days: 0.3, last_reviewed_at: NOW }),
    person({ first_name: 'Mia', last_name: 'Moore', seen_count: 0 }),
  ];

  it('does not modify the caller’s array', () => {
    const order = people.map((card) => card.first_name);
    sortRoster(people, 'last', NOW);
    expect(people.map((card) => card.first_name)).toEqual(order);
  });

  it('orders by first and last name', () => {
    expect(sortRoster(people, 'first', NOW).map((card) => card.first_name)).toEqual(['Adam', 'Mia', 'Zoe']);
    expect(sortRoster(people, 'last', NOW).map((card) => card.last_name)).toEqual(['Adams', 'Moore', 'Zhao']);
  });

  it('puts the weakest first when ordering by predicted recall', () => {
    const order = sortRoster(people, 'recall', NOW).map((card) => card.first_name);
    expect(order[order.length - 1]).toBe('Zoe');
  });

  it('puts the lowest learning strength first', () => {
    expect(sortRoster(people, 'strength', NOW).map((card) => card.first_name)).toEqual(['Adam', 'Mia', 'Zoe']);
  });

  it('puts the hardest-won people first and the unstudied last', () => {
    const order = sortRoster(people, 'difficulty', NOW).map((card) => card.first_name);
    expect(order[0]).toBe('Adam');
    // Mia has never been studied, so she has shown no difficulty at all.
    expect(order[order.length - 1]).toBe('Mia');
  });

  it('separates strength from recall, which is strength decayed by time', () => {
    // Same stored strength; one reviewed today, one a month ago.
    const fresh = person({ first_name: 'Fresh', last_name: 'A', seen_count: 5, mastery: 0.9, stability_days: 3, last_reviewed_at: NOW });
    const stale = person({ first_name: 'Stale', last_name: 'B', seen_count: 5, mastery: 0.9, stability_days: 3, last_reviewed_at: '2026-02-01T12:00:00+00:00' });
    expect(sortRoster([fresh, stale], 'strength', NOW).map((c) => c.first_name)).toEqual(['Fresh', 'Stale']);
    expect(sortRoster([fresh, stale], 'recall', NOW).map((c) => c.first_name)).toEqual(['Stale', 'Fresh']);
  });

  it('is stable for people who tie, so the view does not shuffle', () => {
    const tied = [
      person({ first_name: 'Bea', last_name: 'Young', seen_count: 4, right_count: 2, wrong_count: 2, mastery: 0.5 }),
      person({ first_name: 'Ann', last_name: 'Young', seen_count: 4, right_count: 2, wrong_count: 2, mastery: 0.5 }),
    ];
    expect(sortRoster(tied, 'difficulty', NOW).map((c) => c.first_name)).toEqual(['Ann', 'Bea']);
    expect(sortRoster(tied, 'strength', NOW).map((c) => c.first_name)).toEqual(['Ann', 'Bea']);
  });
});
