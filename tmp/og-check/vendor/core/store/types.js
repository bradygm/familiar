/**
 * The storage seam.
 *
 * Everything the interface does is store or fetch. No decisions about the
 * learning model live here — that is `core/src/model.ts`, and both
 * implementations of this interface compute from it identically.
 *
 * There are two implementations because there are two builds. The local build
 * keeps a real SQLite file and reaches it over HTTP on the learner's own
 * machine; the hosted build has no server at all and keeps everything in the
 * browser. Choosing between them is the only thing that differs, and it is
 * decided at build time, so neither bundle carries the other's code.
 *
 * ## Portraits
 *
 * A card arrives with `portrait_url` already filled in: a path under the server
 * for one implementation, a blob URL for the other. Resolving it in the store
 * rather than in the UI is what keeps rendering synchronous — reading a blob out
 * of IndexedDB is asynchronous, and threading that through every template would
 * push the difference between the two builds into the part that should not know
 * about it.
 */
export {};
//# sourceMappingURL=types.js.map