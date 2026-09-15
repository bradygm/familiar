/**
 * Choosing a store.
 *
 * The build decides, not the running app, so the hosted bundle carries no HTTP
 * client and the local bundle carries no IndexedDB code. `FAMILIAR_STORE` is
 * replaced at build time; with no bundler in play yet it falls back to the HTTP
 * store, which is what the local build wants anyway.
 */
import type { Store } from './types.js';
export type StoreKind = 'http' | 'indexeddb';
export declare function createStore(kind?: StoreKind): Store;
export { HttpStore } from './http.js';
export { IndexedDbStore } from './indexeddb.js';
export { readZip, writeZip, crc32, type ZipEntry } from './zip.js';
export { extractRoster, type ExtractedPerson, type ExtractionProgress, type ExtractionResult } from './roster-extract.js';
export type { Card, CardProgressRow, Course, CourseStats, ImportOutcome, ReviewOutcome, RestoreCounts, ReviewRecord, SessionSummary, Store, StudyMode, } from './types.js';
//# sourceMappingURL=index.d.ts.map