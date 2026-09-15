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

import { writeZip, type ZipEntry } from './store/zip.js';

const COURSE_ID = 'course-demo';

/** Invented people. Ordinary first names, surnames that could not be mistaken for a roster. */
const PEOPLE: readonly [string, string][] = [
  ['Ada', 'Northwind'],
  ['Bo', 'Fairweather'],
  ['Clara', 'Ashdown'],
  ['Dev', 'Marlowe'],
  ['Elena', 'Brightwater'],
  ['Femi', 'Oakhurst'],
  ['Greta', 'Hollis'],
  ['Hugo', 'Stellamare'],
  ['Ines', 'Calloway'],
  ['Jonas', 'Whitfield'],
  ['Kira', 'Somerled'],
  ['Luca', 'Ravensworth'],
];

/** Distinguishable without being decorative; each avatar gets one. */
const BACKGROUNDS = ['#2f6f9f', '#7a5195', '#bc5090', '#ef5675', '#c2571a', '#2b7a6b', '#4a5d8a', '#8a6d3b'];

/**
 * Draw an avatar for a person.
 *
 * Deliberately a flat illustration: initials on a coloured ground with a
 * suggested head and shoulders. A demo that looked photographic would invite
 * exactly the confusion this app should avoid.
 */
function drawAvatar(first: string, last: string, index: number): HTMLCanvasElement {
  const size = 320;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;

  context.fillStyle = BACKGROUNDS[index % BACKGROUNDS.length]!;
  context.fillRect(0, 0, size, size);

  context.fillStyle = 'rgba(255, 255, 255, 0.22)';
  context.beginPath();
  context.arc(size / 2, size * 0.38, size * 0.17, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(size / 2, size * 0.92, size * 0.32, size * 0.26, 0, Math.PI, Math.PI * 2);
  context.fill();

  context.fillStyle = '#ffffff';
  context.font = `600 ${Math.round(size * 0.17)}px "Avenir Next", Avenir, "Segoe UI", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(`${first[0]}${last[0]}`, size / 2, size * 0.38);
  return canvas;
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.85));
}

/** Deterministic, so the demo looks the same every time it is loaded. */
function pseudoRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Build the demo as a backup bundle.
 *
 * Progress is invented but plausible: a few people well known, most partly
 * learned, a couple never seen, and one completed session behind it, so the
 * roster sorts and the learning meters all have something real to display.
 */
export async function demoBundle(): Promise<File> {
  const random = pseudoRandom(20260101);
  const now = Date.now();
  const entries: ZipEntry[] = [];
  const reviews: { card_id: string; reviewed_at: string; result: 'right' | 'wrong' }[] = [];

  const cards = await Promise.all(
    PEOPLE.map(async ([first, last], index) => {
      const cardId = `${COURSE_ID}-card-${String(index + 1).padStart(2, '0')}`;
      const path = `${COURSE_ID}/${cardId}.jpg`;
      const blob = await jpeg(drawAvatar(first, last, index));
      entries.push({ name: `assets/${path}`, bytes: new Uint8Array(await blob.arrayBuffer()) });

      // Two people are untouched, so "New" is represented; the rest vary.
      const unseen = index >= PEOPLE.length - 2;
      const seen = unseen ? 0 : 2 + Math.floor(random() * 9);
      const wrong = unseen ? 0 : Math.floor(random() * Math.max(1, seen / 2));
      const mastery = unseen ? 0.5 : Math.min(0.97, 0.35 + random() * 0.6);
      const daysAgo = unseen ? 0 : 1 + random() * 9;
      const reviewedAt = new Date(now - daysAgo * 86_400_000).toISOString();

      for (let i = 0; i < Math.min(seen, 6); i += 1) {
        reviews.push({
          card_id: cardId,
          reviewed_at: new Date(now - (daysAgo + (6 - i) * 0.4) * 86_400_000).toISOString(),
          result: i < seen - wrong ? 'right' : 'wrong',
        });
      }

      return {
        id: cardId,
        first_name: first,
        last_name: last,
        facts: [],
        prompt_text: '',
        image_path: path,
        reviewed: 1,
        created_at: new Date(now - 30 * 86_400_000).toISOString(),
        progress: {
          seen_count: seen,
          right_count: seen - wrong,
          wrong_count: wrong,
          mastery,
          stability_days: unseen ? 0.25 : 0.5 + random() * 12,
          last_reviewed_at: unseen ? null : reviewedAt,
          last_result: unseen ? null : 'right',
        },
      };
    }),
  );

  const manifest = {
    schema: 1,
    app: 'familiar',
    exported_at: new Date(now).toISOString(),
    includes_progress: true,
    courses: [
      {
        id: COURSE_ID,
        title: 'Demo class (invented people)',
        source_filename: 'demo.pdf',
        imported_at: new Date(now - 30 * 86_400_000).toISOString(),
        active: 1,
        cards,
        sessions: [
          {
            id: 'demo-session-1',
            mode: 'adaptive',
            started_at: new Date(now - 2 * 86_400_000).toISOString(),
            ended_at: new Date(now - 2 * 86_400_000 + 300_000).toISOString(),
            selected_count: Math.min(10, reviews.length),
            reviewed_count: reviews.length,
            right_count: reviews.filter((review) => review.result === 'right').length,
            wrong_count: reviews.filter((review) => review.result === 'wrong').length,
            readiness_at_completion: 0.58,
            reviews,
          },
        ],
      },
    ],
    missing_assets: [],
  };

  entries.unshift({
    name: 'familiar-bundle.json',
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });
  const archive = await writeZip(entries);
  return new File([archive], 'familiar-demo.zip', { type: 'application/zip' });
}

/** The id the demo occupies, so a caller can tell whether it is already loaded. */
export const DEMO_COURSE_ID = COURSE_ID;
