/**
 * Recognising a person's name in roster text.
 *
 * This is the knowledge that decides what counts as a name on a BYU Flashcards
 * export, and it is deliberately shared: the local importer and the browser one
 * read the same rosters, and two copies of these rules would drift into two
 * different ideas of who is in a class.
 *
 * The rules are cautious on purpose. Everything they accept still has to be
 * approved by the learner before it becomes a card, so a missed name costs one
 * manual addition while a wrongly accepted one costs a rejection — but a rule
 * loose enough to swallow headings and page furniture would bury the real names
 * in noise.
 */

/** A line reading "Lovelace, Ada" — surname first, comma separated. */
const SURNAME_FIRST = /^([A-Z][A-Za-z'\-]+),\s*([A-Z][A-Za-z'\-]+)$/;

/**
 * A line reading "Ada Lovelace", with up to three trailing parts so that
 * "Daniel Ambrosio Palma" and "Ben de Hoyos" survive intact.
 */
const GIVEN_NAME_FIRST = /^(?:Name\s*:\s*)?([A-Z][A-Za-z'\-]+)\s+([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,2})$/;

export interface ExtractedName {
  readonly first_name: string;
  readonly last_name: string;
}

/**
 * Read one line, if it is a name at all.
 *
 * A line in full capitals is rejected: course codes and column headings match
 * the shape of a name otherwise, and "ME EN 275" would become a person.
 */
export function readNameLine(line: string): ExtractedName | null {
  const tidy = line.trim().replace(/\s+/g, ' ');
  if (!tidy) return null;

  const surnameFirst = SURNAME_FIRST.exec(tidy);
  if (surnameFirst) {
    return hasLowercase(surnameFirst[2]!, surnameFirst[1]!)
      ? { first_name: surnameFirst[2]!, last_name: surnameFirst[1]! }
      : null;
  }

  const givenFirst = GIVEN_NAME_FIRST.exec(tidy);
  if (givenFirst) {
    return hasLowercase(givenFirst[1]!, givenFirst[2]!)
      ? { first_name: givenFirst[1]!, last_name: givenFirst[2]! }
      : null;
  }
  return null;
}

function hasLowercase(first: string, last: string): boolean {
  return /[a-z]/.test(`${first}${last}`);
}

/**
 * Read every name in a block of text, keeping the first appearance of each.
 *
 * Order is preserved because it is meaningful: on a roster it follows the page,
 * which is how a name gets matched to the portrait beside it.
 */
export function readNames(text: string): ExtractedName[] {
  const names: ExtractedName[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = readNameLine(line);
    if (!name) continue;
    const key = JSON.stringify([name.first_name, name.last_name]);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Where things sit on a supported roster page, as fractions of the page.
 *
 * The BYU export puts three people per page, each a portrait on the left and a
 * name on the right. These numbers come from that layout and are the reason the
 * importer only claims to support it — a different export needs different
 * numbers, or a person-by-person review of what it found.
 */
export const ROSTER_LAYOUT = {
  /** Names live to the right of this fraction of the page width. */
  nameColumnLeft: 0.45,
  /** The portrait occupies this horizontal band. */
  portraitLeft: 0.1,
  portraitRight: 0.45,
  /** A portrait extends this far above and below its name. */
  portraitHalfHeight: 0.13,
  /** Vertical centres of the three people on a page. */
  rowCentres: [0.216, 0.435, 0.655],
  /** Half-height of a single name cell, when reading rows one at a time. */
  rowHalfHeight: 0.09,
  /** Rendering resolution for OCR. */
  renderDpi: 220,
  /** People per page on the supported layout. */
  peoplePerPage: 3,
} as const;
