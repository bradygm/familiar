/**
 * Continuous mode's promises: it never runs out, it re-ranks as you answer,
 * and missing somebody puts them into an expanding-retrieval cycle rather than
 * leaving them to the ranking.
 */

import { describe, expect, it } from 'vitest';

import { ContinuousSession, type ContinuousCard } from '../src/index.js';

const NOW = '2026-03-01T12:00:00+00:00';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roster(size: number): ContinuousCard[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `c${index}`,
    seen_count: 5,
    mastery: 0.8,
    stability_days: 5,
    last_reviewed_at: NOW,
  }));
}

const session = (cards: ContinuousCard[], seed = 1) =>
  new ContinuousSession(cards, { random: seededRandom(seed) });

describe('ContinuousSession', () => {
  it('refuses to start with no cards', () => {
    expect(() => new ContinuousSession([])).toThrow(/at least one card/);
  });

  it('never runs out, however long the sitting', () => {
    const study = session(roster(6));
    for (let i = 0; i < 500; i += 1) {
      const card = study.next(NOW);
      expect(card).toBeTruthy();
      study.record(i % 4 === 0 ? 'wrong' : 'right', NOW);
    }
    expect(study.stats.reviews).toBe(500);
  });

  it('requires next() before a result can be recorded', () => {
    expect(() => session(roster(3)).record('right', NOW)).toThrow(/Call next\(\)/);
  });

  it('does not modify the caller’s cards', () => {
    const cards = roster(4);
    const snapshot = cards.map((card) => ({ ...card }));
    const study = session(cards);
    study.next(NOW);
    study.record('wrong', NOW);
    expect(cards).toEqual(snapshot);
  });

  it('brings a missed person back within a few reviews', () => {
    const study = session(roster(8));
    const missed = study.next(NOW).id;
    study.record('wrong', NOW);

    const following: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      following.push(study.next(NOW).id);
      study.record('right', NOW);
    }
    expect(following).toContain(missed);
    // Not immediately: a gap is the point of expanding retrieval.
    expect(following[0]).not.toBe(missed);
  });

  it('retires a person from the cycle after three straight recalls', () => {
    const study = session(roster(10));
    const missed = study.next(NOW).id;
    study.record('wrong', NOW);
    expect(study.stats.queued).toBe(1);

    let recalls = 0;
    for (let i = 0; i < 60 && study.stats.queued > 0; i += 1) {
      const card = study.next(NOW);
      study.record('right', NOW);
      if (card.id === missed) recalls += 1;
    }
    expect(recalls).toBe(3);
    expect(study.stats.queued).toBe(0);
    expect(study.stats.recovered).toBe(1);
  });

  it('restarts the cycle when a person is missed again mid-cycle', () => {
    const study = session(roster(10));
    const missed = study.next(NOW).id;
    study.record('wrong', NOW);

    let sawAgain = false;
    for (let i = 0; i < 40; i += 1) {
      const card = study.next(NOW);
      const isTarget = card.id === missed;
      // Miss it a second time the next time it appears.
      study.record(isTarget && !sawAgain ? 'wrong' : 'right', NOW);
      if (isTarget && !sawAgain) {
        sawAgain = true;
        expect(study.stats.queued).toBe(1);
        expect(study.stats.recovered).toBe(0);
      }
    }
    expect(sawAgain).toBe(true);
  });

  it('avoids showing the same person twice in a row', () => {
    const study = session(roster(5));
    let previous = study.next(NOW).id;
    study.record('right', NOW);
    for (let i = 0; i < 50; i += 1) {
      const card = study.next(NOW);
      expect(card.id).not.toBe(previous);
      study.record('right', NOW);
      previous = card.id;
    }
  });

  it('still works on a roster of one, where no repeat can be avoided', () => {
    const study = session(roster(1));
    for (let i = 0; i < 5; i += 1) {
      expect(study.next(NOW).id).toBe('c0');
      study.record('right', NOW);
    }
  });

  it('reports a revisit distinctly from a freshly ranked person', () => {
    const study = session(roster(8));
    study.next(NOW);
    expect(study.currentIsRevisit).toBe(false);
    study.record('wrong', NOW);
    let sawRevisit = false;
    for (let i = 0; i < 6; i += 1) {
      study.next(NOW);
      if (study.currentIsRevisit) sawRevisit = true;
      study.record('right', NOW);
    }
    expect(sawRevisit).toBe(true);
  });

  it('weakens a missed person’s stored state, so ranking favours them', () => {
    const cards = roster(3);
    const study = session(cards);
    const card = study.next(NOW);
    const before = card.mastery;
    const { memory } = study.record('wrong', NOW);
    expect(memory.mastery).toBeLessThan(before);
  });

  it('prefers unseen people when the rest of the roster is well known', () => {
    const cards: ContinuousCard[] = [
      ...roster(6),
      { id: 'fresh', seen_count: 0, mastery: 0.5, stability_days: 0.25, last_reviewed_at: null },
    ];
    const study = session(cards);
    const firstFive = Array.from({ length: 5 }, () => {
      const card = study.next(NOW);
      study.record('right', NOW);
      return card.id;
    });
    expect(firstFive).toContain('fresh');
  });
});
