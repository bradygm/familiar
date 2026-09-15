/**
 * The name rules, checked against the shapes a real roster produces — and
 * against the Python implementation they were ported from, since both read the
 * same exports and must agree on who is in a class.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ROSTER_LAYOUT, readNameLine, readNames } from '../src/index.js';

describe('readNameLine', () => {
  it('reads a plain given-name-first line', () => {
    expect(readNameLine('Ada Lovelace')).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('reads a surname-first line and puts the names back in order', () => {
    expect(readNameLine('Lovelace, Ada')).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('keeps multi-part surnames whole', () => {
    expect(readNameLine('Daniel Ambrosio Palma')).toEqual({ first_name: 'Daniel', last_name: 'Ambrosio Palma' });
    expect(readNameLine('Ben de Hoyos')).toEqual({ first_name: 'Ben', last_name: 'de Hoyos' });
  });

  it('keeps apostrophes and hyphens', () => {
    expect(readNameLine("Siobhan O'Connor")).toEqual({ first_name: 'Siobhan', last_name: "O'Connor" });
    expect(readNameLine('Mary Smith-Jones')).toEqual({ first_name: 'Mary', last_name: 'Smith-Jones' });
  });

  it('tolerates the ragged spacing OCR produces', () => {
    expect(readNameLine('   Ada    Lovelace  ')).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('rejects a line in full capitals, which is page furniture rather than a person', () => {
    // Without this the course code itself becomes a student.
    expect(readNameLine('ME EN 275')).toBeNull();
    expect(readNameLine('WINTER SEMESTER')).toBeNull();
  });

  it('rejects lines that are not names at all', () => {
    for (const line of ['', '   ', '3 students per page', 'Page 4 of 23', '2026-01-01', 'ada lovelace']) {
      expect(readNameLine(line), line).toBeNull();
    }
  });

  it('rejects a name with too many trailing parts to be one', () => {
    expect(readNameLine('Ada Lovelace Smith Jones Brown Green')).toBeNull();
  });
});

describe('readNames', () => {
  it('keeps the first appearance of each person, in page order', () => {
    const text = ['Zoe Adams', 'Ada Lovelace', 'ME EN 275', 'Ada Lovelace', 'Ben de Hoyos'].join('\n');
    expect(readNames(text).map((name) => name.first_name)).toEqual(['Zoe', 'Ada', 'Ben']);
  });

  it('finds nothing in a page of furniture', () => {
    expect(readNames('ME EN 275 - 001\n\nPage 1\n')).toEqual([]);
  });
});

describe('ROSTER_LAYOUT', () => {
  it('describes three people per page, matching the supported export', () => {
    expect(ROSTER_LAYOUT.rowCentres).toHaveLength(ROSTER_LAYOUT.peoplePerPage);
  });

  it('puts every row centre inside the page', () => {
    for (const centre of ROSTER_LAYOUT.rowCentres) {
      expect(centre - ROSTER_LAYOUT.rowHalfHeight).toBeGreaterThan(0);
      expect(centre + ROSTER_LAYOUT.rowHalfHeight).toBeLessThan(1);
    }
  });

  it('keeps the portrait band left of the name column', () => {
    expect(ROSTER_LAYOUT.portraitRight).toBeLessThanOrEqual(ROSTER_LAYOUT.nameColumnLeft);
    expect(ROSTER_LAYOUT.portraitLeft).toBeLessThan(ROSTER_LAYOUT.portraitRight);
  });
});

describe('agreement with the Python importer', () => {
  // Generated from backend/app/importer.py. Both builds read the same rosters,
  // so a line either implementation treats differently is a class where the two
  // disagree about who is in it.
  const cases: {
    lines: { line: string; expected: { first_name: string; last_name: string } | null }[];
    blocks: { text: string; expected: { first_name: string; last_name: string }[] }[];
  } = JSON.parse(readFileSync(fileURLToPath(new URL('../../tests/fixtures/roster_name_cases.json', import.meta.url)), 'utf8'));

  it.each(cases.lines.map((testCase, index) => [index, testCase] as const))('line %i: %o', (_index, testCase) => {
    expect(readNameLine(testCase.line)).toEqual(testCase.expected);
  });

  it.each(cases.blocks.map((testCase, index) => [index, testCase] as const))('block %i', (_index, testCase) => {
    expect(readNames(testCase.text)).toEqual(testCase.expected);
  });
});
