/**
 * The store backed by the browser, for the build that has no server.
 *
 * Same interface as the HTTP store, same shapes in and out, so the UI cannot
 * tell which one it is running against. The differences are all here:
 * relationships are maintained by hand rather than by foreign keys, ordering is
 * done in memory rather than in SQL, and portraits are blobs rather than files.
 *
 * ## What this deliberately does not do
 *
 * Importing a roster PDF needs rendering and OCR, which arrive with the browser
 * extractor. Until then those two methods say so plainly rather than failing in
 * some more confusing way. Everything else — studying, reviewing, approving,
 * resetting, backing up and restoring — works here now.
 *
 * ## Durability
 *
 * IndexedDB is a good cache of the learner's own data and a poor system of
 * record: a site-data clear removes it, and Safari evicts it after seven days
 * without a visit unless storage is persisted. That is why import and export of
 * a backup bundle are part of this store rather than an extra, and why the
 * hosted build asks for persistent storage and nags about backups.
 */
import { cardPredictedRecall } from '../model.js';
import { type ExtractionProgress } from './roster-extract.js';
import type { Card, Course, CourseStats, ImportOutcome, RestoreCounts, ReviewRecord, SessionSummary, Store, StudyMode } from './types.js';
export declare class IndexedDbStore implements Store {
    readonly kind: "indexeddb";
    private database;
    /** Blob URLs are cached per portrait, so one card does not leak a URL per render. */
    private readonly portraits;
    private db;
    /**
     * Release the connection and any blob URLs handed out.
     *
     * A held-open connection blocks `deleteDatabase`, so anything that replaces
     * the database — a restore into a fresh profile, or a test — has to close
     * first rather than assume garbage collection will get there in time.
     */
    close(): void;
    private readAll;
    private get;
    private portraitUrl;
    private decorate;
    private cardsOf;
    listCourses(): Promise<Course[]>;
    getCourse(courseId: string): Promise<Course>;
    listCards(courseId: string): Promise<Card[]>;
    listCandidates(courseId: string): Promise<Card[]>;
    getCourseStats(courseId: string): Promise<CourseStats>;
    getCardHistory(_courseId: string, cardId: string): Promise<{
        result: any;
        reviewed_at: any;
    }[]>;
    /** Reports extraction progress, since reading a scanned class takes a while. */
    onExtractionProgress: ((progress: ExtractionProgress) => void) | null;
    createCourseFromRoster(file: File, title?: string): Promise<ImportOutcome>;
    importRosterIntoCourse(courseId: string, file: File): Promise<ImportOutcome>;
    /**
     * Read a roster and fold it into a course.
     *
     * Mirrors the native importer's rules exactly, because both read the same
     * exports: people already present keep their study history untouched and only
     * gain a portrait if they had none, newcomers arrive unreviewed for approval,
     * and matching is exact on first and last name.
     */
    private absorbRoster;
    addCard(courseId: string, person: {
        first_name: string;
        last_name: string;
        facts: string[];
    }, portrait?: Blob | null): Promise<{
        id: string;
    }>;
    approveCandidate(_courseId: string, cardId: string): Promise<void>;
    rejectCandidate(_courseId: string, cardId: string): Promise<void>;
    removeCard(_courseId: string, cardId: string): Promise<void>;
    /** Removes a person and everything that belonged only to them. */
    private deleteCard;
    resetCourseProgress(courseId: string, confirmTitle: string): Promise<void>;
    deleteCourse(courseId: string, confirmTitle: string): Promise<void>;
    startSession(courseId: string, mode: StudyMode, cardIds: string[]): Promise<{
        id: string;
    }>;
    recordReview(sessionId: string, review: ReviewRecord): Promise<void>;
    completeSession(sessionId: string, readiness: number | null): Promise<SessionSummary>;
    downloadExport(courseId?: string, options?: {
        includeProgress?: boolean;
    }): Promise<void>;
    /** Build a bundle byte-for-byte compatible with the one the server writes. */
    exportBundle(courseId?: string, options?: {
        includeProgress?: boolean;
    }): Promise<Blob>;
    /**
     * Load a bundle written by either build.
     *
     * Refuses rather than merges, exactly as the server's restore does: a silent
     * merge of two divergent histories is how reviews get lost quietly.
     */
    importBundle(source: File | ArrayBuffer): Promise<RestoreCounts>;
    /** Predicted recall for a card, so callers need not import the model twice. */
    static recall: typeof cardPredictedRecall;
}
//# sourceMappingURL=indexeddb.d.ts.map