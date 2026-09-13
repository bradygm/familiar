/**
 * Adaptive selection is randomised by design, so it is tested for the
 * properties the product promises rather than for an exact card order. These
 * mirror `tests/test_adaptive_selection.py`, so both implementations are held
 * to the same guarantees even though they will not agree card for card.
 */

import { describe, expect, it } from 'vitest';

import { adaptiveCards, predictedRecall, selectionScore, type CardProgress } from '../src/index.js';

const NOW = '2026-03-01T12:00:00+00:00';

/** Small deterministic PRNG, so a failure is reproducible. */
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

interface TestCard extends CardProgress {
  readonly id: string;
}

function card(id: string, overrides: Partial<CardProgress> = {}): TestCard {
  return {
    id,
    seen_count: 0,
    mastery: 0.5,
    stability_days: 0.25,
    last_reviewed_at: null,
    ...overrides,
  };
}

const strong = (id: string) =>
  card(id, { seen_count: 12, mastery: 0.98, stability_days: 120, last_reviewed_at: NOW });
const weak = (id: string) =>
  card(id, { seen_count: 4, mastery: 0.1, stability_days: 0.04, last_reviewed_at: '2026-01-01T12:00:00+00:00' });

describe('adaptiveCards', () => {
  it('returns every card when the course is smaller than the limit', () => {
    const cards = Array.from({ length: 5 }, (_, index) => card(`c${index}`));
    const selected = adaptiveCards(cards, 15, { now: NOW, random: seededRandom(1) });
    expect(selected.map((item) => item.id).sort()).toEqual(cards.map((item) => item.id).sort());
  });

  it('respects the limit and never repeats a card', () => {
    const cards = Array.from({ length: 60 }, (_, index) => card(`c${index}`, { seen_count: index % 4 }));
    const selected = adaptiveCards(cards, 15, { now: NOW, random: seededRandom(2) });
    expect(selected).toHaveLength(15);
    expect(new Set(selected.map((item) => item.id)).size).toBe(15);
  });

  it('never excludes a card for not being due', () => {
    // Every card is as well known as the model allows. Repeated sessions must
    // still eventually reach all of them, because nothing is ever gated.
    const cards = Array.from({ length: 40 }, (_, index) => strong(`s${index}`));
    const random = seededRandom(11);
    const reached = new Set<string>();
    for (let session = 0; session < 200; session += 1) {
      for (const item of adaptiveCards(cards, 10, { now: NOW, random })) reached.add(item.id);
    }
    expect(reached.size).toBe(cards.length);
  });

  it('lets weak cards dominate a session over strong ones', () => {
    const cards = [
      ...Array.from({ length: 10 }, (_, index) => weak(`w${index}`)),
      ...Array.from({ length: 40 }, (_, index) => strong(`s${index}`)),
    ];
    const random = seededRandom(7);
    const shares: number[] = [];
    for (let session = 0; session < 40; session += 1) {
      const selected = adaptiveCards(cards, 15, { now: NOW, random });
      shares.push(selected.filter((item) => item.id.startsWith('w')).length);
    }
    // 80% of a session is drawn from the top-scoring cards, so all ten weak
    // cards should almost always appear.
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(9);
    expect(shares.reduce((a, b) => a + b, 0) / shares.length).toBeGreaterThan(9.5);
  });

  it('does not modify the caller’s array', () => {
    const cards = Array.from({ length: 30 }, (_, index) => card(`c${index}`));
    const snapshot = cards.map((item) => item.id);
    adaptiveCards(cards, 10, { now: NOW, random: seededRandom(3) });
    expect(cards.map((item) => item.id)).toEqual(snapshot);
  });

  it('defaults to Math.random and the current time without options', () => {
    const cards = Array.from({ length: 30 }, (_, index) => card(`c${index}`));
    expect(adaptiveCards(cards, 10)).toHaveLength(10);
  });
});

describe('selectionScore ranking', () => {
  it('ranks unseen cards above equally recalled seen cards', () => {
    expect(selectionScore(0, 0.5)).toBeGreaterThan(selectionScore(5, 0.5));
  });

  it('ranks lower predicted recall above higher', () => {
    expect(selectionScore(5, 0.1)).toBeGreaterThan(selectionScore(5, 0.9));
  });

  it('raises a card’s score as time since review decays its recall', () => {
    const fresh = predictedRecall(0.9, 7, 0);
    const stale = predictedRecall(0.9, 7, 30);
    expect(selectionScore(5, stale)).toBeGreaterThan(selectionScore(5, fresh));
  });
});
