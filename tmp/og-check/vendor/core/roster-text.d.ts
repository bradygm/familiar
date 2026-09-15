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
export declare function readNameLine(line: string): ExtractedName | null;
/**
 * Read every name in a block of text, keeping the first appearance of each.
 *
 * Order is preserved because it is meaningful: on a roster it follows the page,
 * which is how a name gets matched to the portrait beside it.
 */
export declare function readNames(text: string): ExtractedName[];
/**
 * Where things sit on a supported roster page, as fractions of the page.
 *
 * The BYU export puts three people per page, each a portrait on the left and a
 * name on the right. These numbers come from that layout and are the reason the
 * importer only claims to support it — a different export needs different
 * numbers, or a person-by-person review of what it found.
 */
export declare const ROSTER_LAYOUT: {
    /** Names live to the right of this fraction of the page width. */
    readonly nameColumnLeft: 0.45;
    /** The portrait occupies this horizontal band. */
    readonly portraitLeft: 0.1;
    readonly portraitRight: 0.45;
    /** A portrait extends this far above and below its name. */
    readonly portraitHalfHeight: 0.13;
    /** Vertical centres of the three people on a page. */
    readonly rowCentres: readonly [0.216, 0.435, 0.655];
    /** Half-height of a single name cell, when reading rows one at a time. */
    readonly rowHalfHeight: 0.09;
    /** Rendering resolution for OCR. */
    readonly renderDpi: 220;
    /** People per page on the supported layout. */
    readonly peoplePerPage: 3;
};
//# sourceMappingURL=roster-text.d.ts.map