/**
 * Deciding who is new.
 *
 * A class is built from one or more roster exports, and the learner says which
 * class each export belongs to. So the only question left at import time is
 * which of the extracted people are already in that class — the rule below,
 * shared by every build so it cannot drift between the local importer and the
 * browser one.
 *
 * Matching is exact on first and last name, deliberately. A fuzzy matcher that
 * silently folded "Mike Chen" into "Michael Chen" would quietly merge two
 * people's study histories, which is unrecoverable. Anything that is not an
 * exact match arrives as a new candidate, and the learner approves or rejects
 * it during review — where the cost of being wrong is one click.
 */

export interface NamedPerson {
  readonly first_name: string;
  readonly last_name: string;
}

export interface ImportSplit<T extends NamedPerson> {
  /** People not already in the course, in the order they were extracted. */
  readonly newcomers: T[];
  /** Extracted people who match somebody already present. */
  readonly alreadyPresent: T[];
}

/**
 * A comparable identity for a person.
 *
 * Whitespace is tidied so a ragged OCR read does not invent a new person, but
 * nothing else is normalised. JSON encoding keeps the two names distinct, so
 * "Lee Kim" and "Kim Lee" cannot collide.
 */
export function personKey(person: NamedPerson): string {
  const tidy = (value: string) => value.trim().replace(/\s+/g, ' ');
  return JSON.stringify([tidy(person.first_name), tidy(person.last_name)]);
}

/**
 * Split freshly extracted people into those to add and those already known.
 *
 * Repeats within a single extraction count as already present after their first
 * appearance, so a name read twice off one roster does not become two people.
 */
export function splitNewPeople<T extends NamedPerson>(
  existing: readonly NamedPerson[],
  extracted: readonly T[],
): ImportSplit<T> {
  const known = new Set(existing.map(personKey));
  const newcomers: T[] = [];
  const alreadyPresent: T[] = [];
  for (const person of extracted) {
    const key = personKey(person);
    if (known.has(key)) {
      alreadyPresent.push(person);
    } else {
      known.add(key);
      newcomers.push(person);
    }
  }
  return { newcomers, alreadyPresent };
}
