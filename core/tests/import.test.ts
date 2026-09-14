/** Who counts as already in the class. */

import { describe, expect, it } from 'vitest';

import { personKey, splitNewPeople } from '../src/index.js';

const person = (first_name: string, last_name: string) => ({ first_name, last_name });

describe('splitNewPeople', () => {
  it('adds everybody when the course is empty', () => {
    const extracted = [person('Ada', 'Lovelace'), person('Alan', 'Turing')];
    const { newcomers, alreadyPresent } = splitNewPeople([], extracted);
    expect(newcomers).toEqual(extracted);
    expect(alreadyPresent).toEqual([]);
  });

  it('adds only the people who are not already there', () => {
    const existing = [person('Ada', 'Lovelace')];
    const { newcomers, alreadyPresent } = splitNewPeople(existing, [
      person('Ada', 'Lovelace'),
      person('Grace', 'Hopper'),
    ]);
    expect(newcomers).toEqual([person('Grace', 'Hopper')]);
    expect(alreadyPresent).toEqual([person('Ada', 'Lovelace')]);
  });

  it('re-importing the very same roster adds nobody', () => {
    const roster = [person('Ada', 'Lovelace'), person('Alan', 'Turing'), person('Grace', 'Hopper')];
    expect(splitNewPeople(roster, roster).newcomers).toEqual([]);
  });

  it('does not turn a name read twice off one roster into two people', () => {
    const { newcomers } = splitNewPeople([], [person('Ada', 'Lovelace'), person('Ada', 'Lovelace')]);
    expect(newcomers).toHaveLength(1);
  });

  it('ignores surrounding and repeated whitespace when comparing', () => {
    const existing = [person('Ada', 'Lovelace')];
    const { newcomers } = splitNewPeople(existing, [person('  Ada ', 'Lovelace'), person('Ada', 'Love  lace')]);
    // The first is the same person; the second genuinely differs.
    expect(newcomers).toEqual([person('Ada', 'Love  lace')]);
  });

  it('treats a different spelling as a different person, for the learner to judge', () => {
    // Deliberate: silently folding these together would merge two study
    // histories irreversibly. Being wrong the other way costs one click.
    const existing = [person('Michael', 'Chen')];
    const { newcomers } = splitNewPeople(existing, [person('Mike', 'Chen')]);
    expect(newcomers).toEqual([person('Mike', 'Chen')]);
  });

  it('is case sensitive, so a re-export that changes case is reviewed not merged', () => {
    expect(splitNewPeople([person('Ada', 'Lovelace')], [person('ADA', 'LOVELACE')]).newcomers).toHaveLength(1);
  });

  it('preserves extraction order for the people it adds', () => {
    const extracted = [person('C', 'C'), person('A', 'A'), person('B', 'B')];
    expect(splitNewPeople([], extracted).newcomers.map((p) => p.first_name)).toEqual(['C', 'A', 'B']);
  });

  it('does not modify either input', () => {
    const existing = [person('Ada', 'Lovelace')];
    const extracted = [person('Grace', 'Hopper')];
    const before = [JSON.stringify(existing), JSON.stringify(extracted)];
    splitNewPeople(existing, extracted);
    expect([JSON.stringify(existing), JSON.stringify(extracted)]).toEqual(before);
  });

  it('keeps first and last name distinct in the key', () => {
    expect(personKey(person('Lee', 'Kim'))).not.toBe(personKey(person('Kim', 'Lee')));
  });
});
