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

import type { CardHistory } from '../model.js';

export type StudyMode = 'adaptive' | 'morris' | 'all' | 'continuous';
export type ReviewOutcome = 'right' | 'wrong';

export interface Course {
  readonly id: string;
  readonly title: string;
  readonly source_filename: string;
  readonly imported_at: string;
  readonly card_count?: number;
  readonly session_count?: number;
  readonly last_studied_at?: string | null;
  /** Raw progress rows, summarised by the caller through the shared core. */
  readonly progress?: readonly CardProgressRow[];
}

export interface CardProgressRow {
  readonly seen_count: number;
  readonly mastery: number;
  readonly stability_days: number;
  readonly last_reviewed_at: string | null;
}

export interface Card extends CardHistory {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly facts: readonly string[];
  readonly image_path: string | null;
  /** Ready to use in an `<img src>`, whichever build produced it. */
  readonly portrait_url: string | null;
  readonly last_result?: string | null;
}

export interface CourseStats {
  readonly reviews: number;
  readonly right_count: number;
  readonly wrong_count: number;
  readonly session_count: number;
  readonly progress: readonly CardProgressRow[];
  readonly readiness_trend: readonly { ended_at: string; readiness: number }[];
}

export interface ReviewRecord {
  readonly card_id: string;
  readonly result: ReviewOutcome;
  readonly mastery: number;
  readonly stability_days: number;
  readonly reviewed_at: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly mode: string;
  readonly reviewed_count: number;
  readonly right_count: number;
  readonly wrong_count: number;
  readonly people_count: number;
  readonly ended_at: string | null;
  readonly readiness_at_completion: number | null;
}

export interface ImportOutcome {
  readonly status: 'created' | 'updated';
  readonly course_id: string;
  readonly pages: number;
  readonly found: number;
  readonly added: number;
  readonly already_present: number;
  readonly warning: string | null;
}

export interface Store {
  // Reading
  listCourses(): Promise<Course[]>;
  getCourse(courseId: string): Promise<Course>;
  listCards(courseId: string): Promise<Card[]>;
  listCandidates(courseId: string): Promise<Card[]>;
  getCourseStats(courseId: string): Promise<CourseStats>;
  getCardHistory(courseId: string, cardId: string): Promise<{ result: string; reviewed_at: string }[]>;

  // Building a roster
  createCourseFromRoster(file: File, title?: string): Promise<ImportOutcome>;
  importRosterIntoCourse(courseId: string, file: File): Promise<ImportOutcome>;
  addCard(courseId: string, person: { first_name: string; last_name: string; facts: string[] }): Promise<{ id: string }>;
  approveCandidate(courseId: string, cardId: string): Promise<void>;
  rejectCandidate(courseId: string, cardId: string): Promise<void>;
  removeCard(courseId: string, cardId: string): Promise<void>;

  /** Discards the course's study history. Guarded by repeating the title back. */
  resetCourseProgress(courseId: string, confirmTitle: string): Promise<void>;

  // Studying
  startSession(courseId: string, mode: StudyMode, cardIds: string[]): Promise<{ id: string }>;
  recordReview(sessionId: string, review: ReviewRecord): Promise<void>;
  completeSession(sessionId: string, readiness: number | null): Promise<SessionSummary>;

  /** Where a backup of this course, or of everything, can be downloaded. */
  exportUrl(courseId?: string, options?: { includeProgress?: boolean }): string;
}
