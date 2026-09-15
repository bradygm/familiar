/**
 * A demo class, so the app can be tried without a real roster.
 *
 * Somebody evaluating this should not have to hand it a file of student
 * photographs to find out whether it is any good. The demo is twelve invented
 * people with drawn avatars — obviously not photographs, so nobody can mistake
 * them for real students — and a little study history, so the roster views and
 * the learning meters have something to show rather than reading as empty.
 *
 * It is assembled as an ordinary backup bundle and handed to the store's own
 * import. That reuses the path real data takes rather than adding a second way
 * into the database, and it means the demo works in both builds for free.
 */
/**
 * Build the demo as a backup bundle.
 *
 * Progress is invented but plausible: a few people well known, most partly
 * learned, a couple never seen, and one completed session behind it, so the
 * roster sorts and the learning meters all have something real to display.
 */
export declare function demoBundle(): Promise<File>;
/** The id the demo occupies, so a caller can tell whether it is already loaded. */
export declare const DEMO_COURSE_ID = "course-demo";
//# sourceMappingURL=demo.d.ts.map