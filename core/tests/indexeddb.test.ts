/**
 * The browser store, held to the same behaviour as the server one.
 *
 * The important test here is the last: a bundle written by the Python backend
 * from the real local database is loaded into this store, and every course,
 * person, session and review has to come back identical. That is what makes the
 * two implementations interchangeable rather than merely similar, and it is the
 * migration path for somebody moving from the local build to the hosted one.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { IndexedDbStore, readZip, writeZip } from '../src/index.js';

let current: IndexedDbStore | null = null;

/**
 * Each test gets its own database. The previous connection must be closed and
 * the deletion awaited: an open connection blocks deleteDatabase, and the next
 * open then waits on a delete that will never finish.
 */
async function freshStore(): Promise<IndexedDbStore> {
  current?.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('familiar');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('deleteDatabase blocked by an open connection'));
  });
  current = new IndexedDbStore();
  return current;
}

async function seedCourse(store: IndexedDbStore, id = 'course-1', title = 'Test Course') {
  const bundle = await writeZip([
    {
      name: 'familiar-bundle.json',
      bytes: new TextEncoder().encode(
        JSON.stringify({
          schema: 1,
          app: 'familiar',
          exported_at: '2026-03-01T12:00:00+00:00',
          includes_progress: true,
          courses: [
            {
              id,
              title,
              source_filename: 'roster.pdf',
              imported_at: '2026-01-01T00:00:00+00:00',
              active: 1,
              cards: [
                { id: `${id}-a`, first_name: 'Ada', last_name: 'Lovelace', facts: ['first'], image_path: `${id}/a.jpg`, reviewed: 1, created_at: '2026-01-01T00:00:00+00:00', progress: { seen_count: 2, right_count: 2, wrong_count: 0, mastery: 0.8, stability_days: 4, last_reviewed_at: '2026-02-01T00:00:00+00:00', last_result: 'right' } },
                { id: `${id}-b`, first_name: 'Grace', last_name: 'Hopper', facts: [], image_path: null, reviewed: 1, created_at: '2026-01-01T00:00:00+00:00', progress: { seen_count: 0, right_count: 0, wrong_count: 0, mastery: 0.5, stability_days: 0.25, last_reviewed_at: null, last_result: null } },
                { id: `${id}-c`, first_name: 'Alan', last_name: 'Turing', facts: [], image_path: null, reviewed: 0, created_at: '2026-01-01T00:00:00+00:00', progress: { seen_count: 0, right_count: 0, wrong_count: 0, mastery: 0.5, stability_days: 0.25, last_reviewed_at: null, last_result: null } },
              ],
              sessions: [],
            },
          ],
          missing_assets: [],
        }),
      ),
    },
    { name: `assets/${id}/a.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  ]);
  await store.importBundle(await bundle.arrayBuffer());
}

describe('zip', () => {
  it('round-trips text and binary entries', async () => {
    const text = new TextEncoder().encode('{"hello":"world"}'.repeat(50));
    const binary = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xd9]);
    const archive = await writeZip([
      { name: 'manifest.json', bytes: text },
      { name: 'assets/photo.jpg', bytes: binary },
    ]);
    const entries = await readZip(await archive.arrayBuffer());
    expect(entries.get('manifest.json')).toEqual(text);
    expect(entries.get('assets/photo.jpg')).toEqual(binary);
  });

  it('refuses something that is not a zip', async () => {
    await expect(readZip(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).rejects.toThrow(/not a zip/);
  });
});

describe('IndexedDbStore', () => {
  let store: IndexedDbStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it('starts empty', async () => {
    expect(await store.listCourses()).toEqual([]);
  });

  it('separates approved people from candidates', async () => {
    await seedCourse(store);
    expect((await store.listCards('course-1')).map((card) => card.first_name)).toEqual(['Ada', 'Grace']);
    expect((await store.listCandidates('course-1')).map((card) => card.first_name)).toEqual(['Alan']);
  });

  it('reports course totals the way the server does', async () => {
    await seedCourse(store);
    const [course] = await store.listCourses();
    expect(course!.card_count).toBe(2);
    expect(course!.session_count).toBe(0);
    expect(course!.progress).toHaveLength(2);
  });

  it('resolves a portrait to a usable url, and leaves people without one alone', async () => {
    await seedCourse(store);
    const cards = await store.listCards('course-1');
    expect(cards.find((card) => card.first_name === 'Ada')!.portrait_url).toMatch(/^blob:/);
    expect(cards.find((card) => card.first_name === 'Grace')!.portrait_url).toBeNull();
  });

  it('records a review exactly as it was computed, and counts it', async () => {
    await seedCourse(store);
    const session = await store.startSession('course-1', 'adaptive', ['course-1-a']);
    await store.recordReview(session.id, {
      card_id: 'course-1-a',
      result: 'wrong',
      mastery: 0.4123456789,
      stability_days: 1.6180339887,
      reviewed_at: '2026-03-01T12:00:00.123456+00:00',
    });
    const card = (await store.listCards('course-1')).find((item) => item.id === 'course-1-a')!;
    expect(card.mastery).toBe(0.4123456789);
    expect(card.stability_days).toBe(1.6180339887);
    expect(card.seen_count).toBe(3);
    expect(card.wrong_count).toBe(1);
    expect(card.last_reviewed_at).toBe('2026-03-01T12:00:00.123456+00:00');
  });

  it('refuses a session containing somebody not in the course', async () => {
    await seedCourse(store);
    await expect(store.startSession('course-1', 'adaptive', ['nobody'])).rejects.toThrow(/no longer available/);
  });

  it('refuses to study a candidate who has not been approved', async () => {
    await seedCourse(store);
    await expect(store.startSession('course-1', 'adaptive', ['course-1-c'])).rejects.toThrow(/no longer available/);
  });

  it('counts attempts and people separately when a person repeats', async () => {
    await seedCourse(store);
    const session = await store.startSession('course-1', 'morris', ['course-1-a', 'course-1-b']);
    for (const card_id of ['course-1-a', 'course-1-b', 'course-1-a']) {
      await store.recordReview(session.id, { card_id, result: 'right', mastery: 0.7, stability_days: 2, reviewed_at: '2026-03-01T12:00:00+00:00' });
    }
    const summary = await store.completeSession(session.id, 0.5);
    expect(summary.reviewed_count).toBe(3);
    expect(summary.people_count).toBe(2);
  });

  it('keeps the first result when a session is completed twice', async () => {
    await seedCourse(store);
    const session = await store.startSession('course-1', 'adaptive', ['course-1-a']);
    const first = await store.completeSession(session.id, 0.3);
    const second = await store.completeSession(session.id, 0.9);
    expect(second.ended_at).toBe(first.ended_at);
    expect(second.readiness_at_completion).toBe(0.3);
  });

  it('approves and rejects candidates', async () => {
    await seedCourse(store);
    await store.approveCandidate('course-1', 'course-1-c');
    expect(await store.listCandidates('course-1')).toHaveLength(0);
    expect(await store.listCards('course-1')).toHaveLength(3);
  });

  it('will not reject somebody already approved', async () => {
    await seedCourse(store);
    await expect(store.rejectCandidate('course-1', 'course-1-a')).rejects.toThrow(/No such candidate/);
  });

  it('removes a person along with their history and portrait', async () => {
    await seedCourse(store);
    const session = await store.startSession('course-1', 'adaptive', ['course-1-a']);
    await store.recordReview(session.id, { card_id: 'course-1-a', result: 'right', mastery: 0.9, stability_days: 5, reviewed_at: '2026-03-01T12:00:00+00:00' });
    await store.removeCard('course-1', 'course-1-a');

    expect((await store.listCards('course-1')).map((card) => card.id)).toEqual(['course-1-b']);
    expect(await store.getCardHistory('course-1', 'course-1-a')).toEqual([]);
    const bundle = await store.exportBundle();
    const entries = await readZip(await bundle.arrayBuffer());
    expect([...entries.keys()].filter((name) => name.startsWith('assets/'))).toEqual([]);
  });

  it('resets a course only when the title is repeated back', async () => {
    await seedCourse(store);
    const session = await store.startSession('course-1', 'adaptive', ['course-1-a']);
    await store.recordReview(session.id, { card_id: 'course-1-a', result: 'right', mastery: 0.9, stability_days: 5, reviewed_at: '2026-03-01T12:00:00+00:00' });

    await expect(store.resetCourseProgress('course-1', 'test course')).rejects.toThrow(/exactly/);
    expect((await store.getCourseStats('course-1')).reviews).toBe(1);

    await store.resetCourseProgress('course-1', 'Test Course');
    const stats = await store.getCourseStats('course-1');
    expect(stats.reviews).toBe(0);
    expect(stats.session_count).toBe(0);
    expect((await store.listCards('course-1')).every((card) => card.seen_count === 0 && card.mastery === 0.5)).toBe(true);
    expect(await store.listCards('course-1')).toHaveLength(2);
  });

  it('refuses to merge a bundle whose courses are already here', async () => {
    await seedCourse(store);
    const bundle = await store.exportBundle();
    await expect(store.importBundle(await bundle.arrayBuffer())).rejects.toThrow(/already here/);
  });

  it('says plainly that reading a roster PDF is not available yet', async () => {
    await expect(store.createCourseFromRoster(new File([], 'r.pdf'))).rejects.toThrow(/hosted build/);
  });
});

describe('a real backup from the local database', () => {
  const BUNDLE = fileURLToPath(new URL('../../tests/fixtures/real-bundle.zip', import.meta.url));

  it.skipIf(!(() => { try { readFileSync(BUNDLE); return true; } catch { return false; } })())(
    'loads into the browser store with every row intact',
    async () => {
      const store = await freshStore();
      const archive = readFileSync(BUNDLE);
      const manifest = JSON.parse(
        new TextDecoder().decode((await readZip(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer)).get('familiar-bundle.json')!),
      );

      const counts = await store.importBundle(
        archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
      );
      const expectedCards = manifest.courses.reduce((total: number, course: any) => total + course.cards.length, 0);
      const expectedReviews = manifest.courses.reduce(
        (total: number, course: any) => total + course.sessions.reduce((sum: number, session: any) => sum + session.reviews.length, 0),
        0,
      );
      expect(counts.courses).toBe(manifest.courses.length);
      expect(counts.cards).toBe(expectedCards);
      expect(counts.reviews).toBe(expectedReviews);

      // Every person's stored memory state must survive exactly: these numbers
      // were accumulated over real sessions and cannot be recomputed.
      for (const course of manifest.courses) {
        const stored = new Map((await store.listCards(course.id)).concat(await store.listCandidates(course.id)).map((card) => [card.id, card]));
        for (const card of course.cards) {
          const actual = stored.get(card.id)!;
          expect(actual, `${card.id} missing after restore`).toBeTruthy();
          expect(actual.mastery).toBe(card.progress.mastery);
          expect(actual.stability_days).toBe(card.progress.stability_days);
          expect(actual.seen_count).toBe(card.progress.seen_count);
          expect(actual.last_reviewed_at).toBe(card.progress.last_reviewed_at);
        }
      }

      // And exporting it again reproduces the same content.
      const round = await readZip(await (await store.exportBundle()).arrayBuffer());
      const again = JSON.parse(new TextDecoder().decode(round.get('familiar-bundle.json')!));
      expect(again.courses.length).toBe(manifest.courses.length);
      for (const [index, course] of manifest.courses.entries()) {
        expect(again.courses[index].cards.map((card: any) => card.id).sort()).toEqual(course.cards.map((card: any) => card.id).sort());
      }
      const portraits = [...round.keys()].filter((name) => name.startsWith('assets/')).sort();
      const original = [...(await readZip(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer)).keys()]
        .filter((name) => name.startsWith('assets/'))
        .sort();
      expect(portraits).toEqual(original);
    },
    60_000,
  );
});
