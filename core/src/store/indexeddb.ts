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
import { extractRoster, type ExtractionProgress } from './roster-extract.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';
import type {
  Card,
  Course,
  CourseStats,
  ImportOutcome,
  RestoreCounts,
  ReviewRecord,
  SessionSummary,
  Store,
  StudyMode,
} from './types.js';

const DATABASE = 'familiar';
const VERSION = 1;
const MANIFEST = 'familiar-bundle.json';

type StoreName = 'courses' | 'cards' | 'progress' | 'sessions' | 'reviews' | 'assets';

const FRESH_PROGRESS = {
  seen_count: 0,
  right_count: 0,
  wrong_count: 0,
  mastery: 0.5,
  stability_days: 0.25,
  last_reviewed_at: null as string | null,
  last_result: null as string | null,
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('courses', { keyPath: 'id' });
      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('course_id', 'course_id');
      db.createObjectStore('progress', { keyPath: 'card_id' });
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('course_id', 'course_id');
      const reviews = db.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
      reviews.createIndex('session_id', 'session_id');
      reviews.createIndex('card_id', 'card_id');
      db.createObjectStore('assets', { keyPath: 'path' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const byName = (left: any, right: any) =>
  String(left.first_name).localeCompare(right.first_name) || String(left.last_name).localeCompare(right.last_name);

export class IndexedDbStore implements Store {
  readonly kind = 'indexeddb' as const;

  private database: IDBDatabase | null = null;
  /** Blob URLs are cached per portrait, so one card does not leak a URL per render. */
  private readonly portraits = new Map<string, string>();

  private async db(): Promise<IDBDatabase> {
    if (!this.database) this.database = await open();
    return this.database;
  }

  /**
   * Release the connection and any blob URLs handed out.
   *
   * A held-open connection blocks `deleteDatabase`, so anything that replaces
   * the database — a restore into a fresh profile, or a test — has to close
   * first rather than assume garbage collection will get there in time.
   */
  close(): void {
    this.database?.close();
    this.database = null;
    for (const url of this.portraits.values()) URL.revokeObjectURL(url);
    this.portraits.clear();
  }

  private async readAll(name: StoreName, index?: string, key?: IDBValidKey): Promise<any[]> {
    const db = await this.db();
    const source = db.transaction(name, 'readonly').objectStore(name);
    return wrap(index ? source.index(index).getAll(key) : source.getAll());
  }

  private async get(name: StoreName, key: IDBValidKey): Promise<any> {
    const db = await this.db();
    return wrap(db.transaction(name, 'readonly').objectStore(name).get(key));
  }

  private async portraitUrl(imagePath: string | null): Promise<string | null> {
    if (!imagePath) return null;
    const cached = this.portraits.get(imagePath);
    if (cached) return cached;
    const asset = await this.get('assets', imagePath);
    if (!asset) return null;
    const url = URL.createObjectURL(asset.blob);
    this.portraits.set(imagePath, url);
    return url;
  }

  private async decorate(cards: any[]): Promise<Card[]> {
    const progress = new Map((await this.readAll('progress')).map((row) => [row.card_id, row]));
    return Promise.all(
      cards.map(async (card) => ({
        ...card,
        ...(progress.get(card.id) ?? FRESH_PROGRESS),
        facts: card.facts ?? [],
        portrait_url: await this.portraitUrl(card.image_path),
      })),
    );
  }

  private async cardsOf(courseId: string, reviewed: 0 | 1): Promise<Card[]> {
    const cards = (await this.readAll('cards', 'course_id', courseId)).filter((card) => (card.reviewed ? 1 : 0) === reviewed);
    return (await this.decorate(cards)).sort(byName);
  }

  async listCourses(): Promise<Course[]> {
    const courses = await this.readAll('courses');
    const cards = await this.readAll('cards');
    const progressRows = new Map((await this.readAll('progress')).map((row) => [row.card_id, row]));
    const sessions = await this.readAll('sessions');

    return courses
      .map((course) => {
        const approved = cards.filter((card) => card.course_id === course.id && card.reviewed);
        const courseSessions = sessions.filter((session) => session.course_id === course.id);
        const ended = courseSessions.map((session) => session.ended_at).filter(Boolean).sort();
        return {
          ...course,
          card_count: approved.length,
          session_count: courseSessions.length,
          last_studied_at: ended.length ? ended[ended.length - 1] : null,
          progress: approved.map((card) => progressRows.get(card.id) ?? FRESH_PROGRESS),
        };
      })
      .sort((left, right) => String(right.imported_at).localeCompare(String(left.imported_at)));
  }

  async getCourse(courseId: string): Promise<Course> {
    const course = await this.get('courses', courseId);
    if (!course) throw new Error('Course not found');
    return course;
  }

  async listCards(courseId: string): Promise<Card[]> {
    return this.cardsOf(courseId, 1);
  }

  async listCandidates(courseId: string): Promise<Card[]> {
    return this.cardsOf(courseId, 0);
  }

  async getCourseStats(courseId: string): Promise<CourseStats> {
    const sessions = (await this.readAll('sessions', 'course_id', courseId)) as any[];
    const sessionIds = new Set(sessions.map((session) => session.id));
    const reviews = (await this.readAll('reviews')).filter((review) => sessionIds.has(review.session_id));
    const approved = await this.listCards(courseId);

    const trend = sessions
      .filter((session) => session.ended_at && session.reviewed_count > 0 && session.readiness_at_completion != null)
      .sort((left, right) => String(left.ended_at).localeCompare(String(right.ended_at)))
      .slice(-20)
      .map((session) => ({ ended_at: session.ended_at, readiness: Math.round(session.readiness_at_completion * 100) }));

    return {
      reviews: reviews.length,
      right_count: reviews.filter((review) => review.result === 'right').length,
      wrong_count: reviews.filter((review) => review.result === 'wrong').length,
      session_count: sessions.length,
      progress: approved.map((card) => ({
        seen_count: card.seen_count,
        mastery: card.mastery,
        stability_days: card.stability_days,
        last_reviewed_at: card.last_reviewed_at,
      })),
      readiness_trend: trend,
    };
  }

  async getCardHistory(_courseId: string, cardId: string) {
    const reviews = await this.readAll('reviews', 'card_id', cardId);
    return reviews
      .sort((left, right) => String(left.reviewed_at).localeCompare(String(right.reviewed_at)))
      .slice(-12)
      .map((review) => ({ result: review.result, reviewed_at: review.reviewed_at }));
  }

  /** Reports extraction progress, since reading a scanned class takes a while. */
  onExtractionProgress: ((progress: ExtractionProgress) => void) | null = null;

  async createCourseFromRoster(file: File, title?: string): Promise<ImportOutcome> {
    const id = `course-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    // Extract before creating anything. A roster that cannot be read must not
    // leave an empty course behind for the learner to puzzle over and delete.
    return this.absorbRoster(id, file, 'created', {
      id,
      title: (title ?? file.name.replace(/\.pdf$/i, '').replace(/_/g, ' ')).trim(),
      source_filename: file.name,
      imported_at: new Date().toISOString(),
      active: 1,
    });
  }

  async importRosterIntoCourse(courseId: string, file: File): Promise<ImportOutcome> {
    await this.getCourse(courseId);
    return this.absorbRoster(courseId, file, 'updated');
  }

  /**
   * Read a roster and fold it into a course.
   *
   * Mirrors the native importer's rules exactly, because both read the same
   * exports: people already present keep their study history untouched and only
   * gain a portrait if they had none, newcomers arrive unreviewed for approval,
   * and matching is exact on first and last name.
   */
  private async absorbRoster(
    courseId: string,
    file: File,
    status: 'created' | 'updated',
    courseToCreate?: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    const { people, pages } = await extractRoster(file, (progress) => this.onExtractionProgress?.(progress));
    if (courseToCreate) {
      const db = await this.db();
      const creating = db.transaction('courses', 'readwrite');
      creating.objectStore('courses').put(courseToCreate);
      await done(creating);
    }
    const existingCards = await this.readAll('cards', 'course_id', courseId);
    const known = new Map(
      existingCards.map((card) => [JSON.stringify([String(card.first_name).trim(), String(card.last_name).trim()]), card]),
    );

    const db = await this.db();
    const transaction = db.transaction(['cards', 'progress', 'assets'], 'readwrite');
    let added = 0;
    let alreadyPresent = 0;

    for (const person of people) {
      const key = JSON.stringify([person.first_name.trim(), person.last_name.trim()]);
      const existing = known.get(key);

      if (existing) {
        alreadyPresent += 1;
        // Only fill a gap. Replacing a portrait somebody is already learning
        // from would change a face out from under them.
        if (person.portrait && !existing.image_path) {
          const path = `${courseId}/person-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}.jpg`;
          transaction.objectStore('assets').put({ path, blob: person.portrait });
          transaction.objectStore('cards').put({ ...existing, image_path: path });
          known.set(key, { ...existing, image_path: path });
        }
        continue;
      }

      const cardId = `${courseId}-card-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      let imagePath: string | null = null;
      if (person.portrait) {
        // Names are unrelated to page position, so a later roster cannot
        // overwrite an earlier person's portrait.
        imagePath = `${courseId}/person-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}.jpg`;
        transaction.objectStore('assets').put({ path: imagePath, blob: person.portrait });
      }
      transaction.objectStore('cards').put({
        id: cardId,
        course_id: courseId,
        first_name: person.first_name,
        last_name: person.last_name,
        facts: [],
        prompt_text: '',
        image_path: imagePath,
        reviewed: 0,
        created_at: new Date().toISOString(),
      });
      transaction.objectStore('progress').put({ card_id: cardId, ...FRESH_PROGRESS });
      known.set(key, { id: cardId, image_path: imagePath });
      added += 1;
    }
    await done(transaction);

    const warning = !people.length
      ? 'No high-confidence name lines were found. Add people manually, or check that this is a 3-students-per-page BYU Flashcards export.'
      : !added
        ? 'Everybody in this roster is already in the course, so nothing was added.'
        : null;

    return {
      status,
      course_id: courseId,
      pages,
      found: people.length,
      added,
      already_present: alreadyPresent,
      warning,
    };
  }

  async addCard(
    courseId: string,
    person: { first_name: string; last_name: string; facts: string[] },
    portrait?: Blob | null,
  ) {
    const id = `${courseId}-card-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    let imagePath: string | null = null;
    const db = await this.db();
    const transaction = db.transaction(['cards', 'progress', 'assets'], 'readwrite');
    if (portrait) {
      imagePath = `${courseId}/person-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}.jpg`;
      transaction.objectStore('assets').put({ path: imagePath, blob: portrait });
    }
    transaction.objectStore('cards').put({
      id,
      course_id: courseId,
      first_name: person.first_name.trim(),
      last_name: person.last_name.trim(),
      facts: person.facts,
      prompt_text: '',
      image_path: imagePath,
      reviewed: 1,
      created_at: new Date().toISOString(),
    });
    transaction.objectStore('progress').put({ card_id: id, ...FRESH_PROGRESS });
    await done(transaction);
    return { id };
  }

  async approveCandidate(_courseId: string, cardId: string): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction('cards', 'readwrite');
    const cards = transaction.objectStore('cards');
    const card = await wrap(cards.get(cardId));
    if (!card) throw new Error('No such candidate awaiting review');
    cards.put({ ...card, reviewed: 1 });
    await done(transaction);
  }

  async rejectCandidate(_courseId: string, cardId: string): Promise<void> {
    const card = await this.get('cards', cardId);
    if (!card || card.reviewed) throw new Error('No such candidate awaiting review');
    await this.deleteCard(cardId);
  }

  async removeCard(_courseId: string, cardId: string): Promise<void> {
    const card = await this.get('cards', cardId);
    if (!card) throw new Error('That person is not in this course');
    await this.deleteCard(cardId);
  }

  /** Removes a person and everything that belonged only to them. */
  private async deleteCard(cardId: string): Promise<void> {
    const card = await this.get('cards', cardId);
    const reviews = await this.readAll('reviews', 'card_id', cardId);
    const others = (await this.readAll('cards')).filter(
      (other) => other.id !== cardId && other.image_path && other.image_path === card?.image_path,
    );

    const db = await this.db();
    const transaction = db.transaction(['cards', 'progress', 'reviews', 'assets'], 'readwrite');
    transaction.objectStore('cards').delete(cardId);
    transaction.objectStore('progress').delete(cardId);
    for (const review of reviews) transaction.objectStore('reviews').delete(review.id);
    // A portrait nobody else is using goes too: somebody no longer in the class
    // should not leave their photograph behind.
    if (card?.image_path && others.length === 0) {
      transaction.objectStore('assets').delete(card.image_path);
      const url = this.portraits.get(card.image_path);
      if (url) {
        URL.revokeObjectURL(url);
        this.portraits.delete(card.image_path);
      }
    }
    await done(transaction);
  }

  async resetCourseProgress(courseId: string, confirmTitle: string): Promise<void> {
    const course = await this.getCourse(courseId);
    if (confirmTitle.trim() !== course.title) {
      throw new Error('Type the course title exactly to confirm resetting its progress.');
    }
    const cards = await this.readAll('cards', 'course_id', courseId);
    const sessions = await this.readAll('sessions', 'course_id', courseId);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const reviews = (await this.readAll('reviews')).filter((review) => sessionIds.has(review.session_id));

    const db = await this.db();
    const transaction = db.transaction(['progress', 'sessions', 'reviews'], 'readwrite');
    for (const card of cards) transaction.objectStore('progress').put({ card_id: card.id, ...FRESH_PROGRESS });
    for (const session of sessions) transaction.objectStore('sessions').delete(session.id);
    for (const review of reviews) transaction.objectStore('reviews').delete(review.id);
    await done(transaction);
  }

  async startSession(courseId: string, mode: StudyMode, cardIds: string[]): Promise<{ id: string }> {
    const available = new Set(
      (await this.readAll('cards', 'course_id', courseId)).filter((card) => card.reviewed).map((card) => card.id),
    );
    if (available.size === 0) throw new Error('Approve or add cards before starting a session');
    const selected = [...new Set(cardIds)];
    if (selected.some((id) => !available.has(id))) throw new Error('One or more cards are no longer available');

    const id = crypto.randomUUID().replace(/-/g, '');
    const db = await this.db();
    const transaction = db.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put({
      id,
      course_id: courseId,
      mode,
      started_at: new Date().toISOString(),
      ended_at: null,
      selected_count: selected.length,
      reviewed_count: 0,
      right_count: 0,
      wrong_count: 0,
      readiness_at_completion: null,
    });
    await done(transaction);
    return { id };
  }

  async recordReview(sessionId: string, review: ReviewRecord): Promise<void> {
    const db = await this.db();
    const session = await this.get('sessions', sessionId);
    if (!session) throw new Error('Session not found');
    const progress = (await this.get('progress', review.card_id)) ?? { card_id: review.card_id, ...FRESH_PROGRESS };

    const transaction = db.transaction(['progress', 'reviews', 'sessions'], 'readwrite');
    transaction.objectStore('progress').put({
      ...progress,
      seen_count: progress.seen_count + 1,
      right_count: progress.right_count + (review.result === 'right' ? 1 : 0),
      wrong_count: progress.wrong_count + (review.result === 'wrong' ? 1 : 0),
      mastery: review.mastery,
      stability_days: review.stability_days,
      last_reviewed_at: review.reviewed_at,
      last_result: review.result,
    });
    transaction.objectStore('reviews').put({
      session_id: sessionId,
      card_id: review.card_id,
      reviewed_at: review.reviewed_at,
      result: review.result,
    });
    transaction.objectStore('sessions').put({
      ...session,
      reviewed_count: session.reviewed_count + 1,
      right_count: session.right_count + (review.result === 'right' ? 1 : 0),
      wrong_count: session.wrong_count + (review.result === 'wrong' ? 1 : 0),
    });
    await done(transaction);
  }

  async completeSession(sessionId: string, readiness: number | null): Promise<SessionSummary> {
    const session = await this.get('sessions', sessionId);
    if (!session) throw new Error('Session not found');
    const reviews = await this.readAll('reviews', 'session_id', sessionId);

    // Completing twice keeps the first result, as the server does.
    const completed = {
      ...session,
      ended_at: session.ended_at ?? new Date().toISOString(),
      readiness_at_completion: session.readiness_at_completion ?? readiness,
    };
    const db = await this.db();
    const transaction = db.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put(completed);
    await done(transaction);

    return { ...completed, people_count: new Set(reviews.map((review) => review.card_id)).size };
  }

  async downloadExport(courseId?: string, options: { includeProgress?: boolean } = {}): Promise<void> {
    const blob = await this.exportBundle(courseId, options);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `familiar-${courseId ?? 'backup'}-${stamp}.zip`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // --- backups -------------------------------------------------------------

  /** Build a bundle byte-for-byte compatible with the one the server writes. */
  async exportBundle(courseId?: string, options: { includeProgress?: boolean } = {}): Promise<Blob> {
    const includeProgress = options.includeProgress !== false;
    const allCourses = await this.readAll('courses');
    const courses = courseId ? allCourses.filter((course) => course.id === courseId) : allCourses;
    if (courseId && courses.length === 0) throw new Error(`Unknown course: ${courseId}`);

    const cards = await this.readAll('cards');
    const progress = new Map((await this.readAll('progress')).map((row) => [row.card_id, row]));
    const sessions = await this.readAll('sessions');
    const reviews = await this.readAll('reviews');
    const entries: ZipEntry[] = [];
    const missing: string[] = [];

    const manifest = {
      schema: 1,
      app: 'familiar',
      exported_at: new Date().toISOString(),
      includes_progress: includeProgress,
      courses: await Promise.all(
        courses
          .sort((left, right) => String(left.imported_at).localeCompare(String(right.imported_at)))
          .map(async (course) => {
            const courseCards = cards
              .filter((card) => card.course_id === course.id)
              .sort((left, right) => String(left.last_name).localeCompare(right.last_name) || String(left.first_name).localeCompare(right.first_name));
            for (const card of courseCards) {
              if (!card.image_path) continue;
              const asset = await this.get('assets', card.image_path);
              if (asset) {
                entries.push({ name: `assets/${card.image_path}`, bytes: new Uint8Array(await asset.blob.arrayBuffer()) });
              } else {
                missing.push(card.image_path);
              }
            }
            const courseSessions = sessions
              .filter((session) => session.course_id === course.id)
              .sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)));
            return {
              id: course.id,
              title: course.title,
              source_filename: course.source_filename,
              imported_at: course.imported_at,
              active: course.active ?? 1,
              cards: courseCards.map((card) => ({
                id: card.id,
                first_name: card.first_name,
                last_name: card.last_name,
                prompt_text: card.prompt_text ?? '',
                image_path: card.image_path,
                reviewed: card.reviewed,
                created_at: card.created_at,
                facts: card.facts ?? [],
                ...(includeProgress
                  ? {
                      progress: (({ card_id, ...rest }) => rest)(progress.get(card.id) ?? { card_id: card.id, ...FRESH_PROGRESS }),
                    }
                  : {}),
              })),
              sessions: includeProgress
                ? courseSessions.map((session) => ({
                    id: session.id,
                    mode: session.mode,
                    started_at: session.started_at,
                    ended_at: session.ended_at,
                    selected_count: session.selected_count,
                    reviewed_count: session.reviewed_count,
                    right_count: session.right_count,
                    wrong_count: session.wrong_count,
                    readiness_at_completion: session.readiness_at_completion,
                    reviews: reviews
                      .filter((review) => review.session_id === session.id)
                      .sort((left, right) => String(left.reviewed_at).localeCompare(String(right.reviewed_at)) || left.id - right.id)
                      .map((review) => ({ card_id: review.card_id, reviewed_at: review.reviewed_at, result: review.result })),
                  }))
                : [],
            };
          }),
      ),
      missing_assets: [] as string[],
    };
    manifest.missing_assets = missing.sort();

    entries.unshift({ name: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    return writeZip(entries);
  }

  /**
   * Load a bundle written by either build.
   *
   * Refuses rather than merges, exactly as the server's restore does: a silent
   * merge of two divergent histories is how reviews get lost quietly.
   */
  async importBundle(source: File | ArrayBuffer): Promise<RestoreCounts> {
    const archive = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
    const files = await readZip(archive);
    const manifestBytes = files.get(MANIFEST);
    if (!manifestBytes) throw new Error('That zip is not a Familiar backup.');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.schema !== 1) throw new Error(`Unsupported bundle schema: ${manifest.schema}`);

    const existing = new Set((await this.readAll('courses')).map((course) => course.id));
    const clashes = manifest.courses.filter((course: any) => existing.has(course.id)).map((course: any) => course.id);
    if (clashes.length) {
      throw new Error(`These courses are already here: ${clashes.join(', ')}. Restore into a fresh browser profile instead of merging.`);
    }

    const counts = { courses: 0, cards: 0, sessions: 0, reviews: 0, assets: 0 };
    const db = await this.db();
    const transaction = db.transaction(['courses', 'cards', 'progress', 'sessions', 'reviews', 'assets'], 'readwrite');

    for (const course of manifest.courses) {
      transaction.objectStore('courses').put({
        id: course.id,
        title: course.title,
        source_filename: course.source_filename,
        imported_at: course.imported_at,
        active: course.active ?? 1,
      });
      counts.courses += 1;

      for (const card of course.cards ?? []) {
        transaction.objectStore('cards').put({
          id: card.id,
          course_id: course.id,
          first_name: card.first_name,
          last_name: card.last_name,
          facts: card.facts ?? [],
          prompt_text: card.prompt_text ?? '',
          image_path: card.image_path ?? null,
          reviewed: card.reviewed ?? 1,
          created_at: card.created_at,
        });
        transaction.objectStore('progress').put({ card_id: card.id, ...FRESH_PROGRESS, ...(card.progress ?? {}) });
        counts.cards += 1;
      }

      for (const session of course.sessions ?? []) {
        transaction.objectStore('sessions').put({
          id: session.id,
          course_id: course.id,
          mode: session.mode,
          started_at: session.started_at,
          ended_at: session.ended_at ?? null,
          selected_count: session.selected_count ?? 0,
          reviewed_count: session.reviewed_count ?? 0,
          right_count: session.right_count ?? 0,
          wrong_count: session.wrong_count ?? 0,
          readiness_at_completion: session.readiness_at_completion ?? null,
        });
        counts.sessions += 1;
        for (const review of session.reviews ?? []) {
          transaction.objectStore('reviews').put({
            session_id: session.id,
            card_id: review.card_id,
            reviewed_at: review.reviewed_at,
            result: review.result,
          });
          counts.reviews += 1;
        }
      }
    }

    for (const [name, bytes] of files) {
      if (!name.startsWith('assets/')) continue;
      const path = name.slice('assets/'.length);
      transaction.objectStore('assets').put({ path, blob: new Blob([bytes as BlobPart], { type: 'image/jpeg' }) });
      counts.assets += 1;
    }

    await done(transaction);
    return counts;
  }

  /** Predicted recall for a card, so callers need not import the model twice. */
  static recall = cardPredictedRecall;
}
