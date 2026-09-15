/**
 * The store backed by the local FastAPI server and its SQLite file.
 *
 * This is the implementation the app has always had, lifted out of the UI
 * unchanged rather than rewritten: the same paths, the same payloads. Its value
 * here is that extracting it defines the interface against something already
 * known to work, so the browser implementation has a specification to meet
 * rather than an intention to match.
 */
import { type ExtractionProgress } from './roster-extract.js';
import type { Card, Course, CourseStats, ImportOutcome, RestoreCounts, ReviewRecord, SessionSummary, Store, StudyMode } from './types.js';
export declare class HttpStore implements Store {
    readonly kind: "http";
    listCourses(): Promise<Course[]>;
    getCourse(courseId: string): Promise<Course>;
    listCards(courseId: string): Promise<Card[]>;
    listCandidates(courseId: string): Promise<Card[]>;
    getCourseStats(courseId: string): Promise<CourseStats>;
    getCardHistory(courseId: string, cardId: string): Promise<any>;
    /** Reports extraction progress, which happens here rather than on the server. */
    onExtractionProgress: ((progress: ExtractionProgress) => void) | null;
    createCourseFromRoster(file: File, title?: string): Promise<ImportOutcome>;
    importRosterIntoCourse(courseId: string, file: File): Promise<ImportOutcome>;
    /**
     * Read the roster here, then send what came out of it.
     *
     * The PDF never travels. Reading it in the page is faster than the native
     * path was, and it keeps a file of student photographs on the machine it was
     * chosen on even though a server is involved.
     */
    private sendRoster;
    addCard(courseId: string, person: {
        first_name: string;
        last_name: string;
        facts: string[];
    }, portrait?: Blob | null): Promise<any>;
    approveCandidate(courseId: string, cardId: string): Promise<void>;
    rejectCandidate(courseId: string, cardId: string): Promise<void>;
    removeCard(courseId: string, cardId: string): Promise<void>;
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
    importBundle(file: File): Promise<RestoreCounts>;
}
//# sourceMappingURL=http.d.ts.map