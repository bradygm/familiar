/**
 * The store backed by the local FastAPI server and its SQLite file.
 *
 * This is the implementation the app has always had, lifted out of the UI
 * unchanged rather than rewritten: the same paths, the same payloads. Its value
 * here is that extracting it defines the interface against something already
 * known to work, so the browser implementation has a specification to meet
 * rather than an intention to match.
 */

import { extractRoster, type ExtractionProgress } from './roster-extract.js';
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

/**
 * How long to wait for the local server before giving up.
 *
 * `fetch` has no timeout of its own: a server that accepts the connection and
 * then stops answering leaves the promise pending for ever, and because every
 * view starts by showing a spinner, that is indistinguishable from a hang. A
 * request that fails at least becomes an error the UI can report and offer to
 * retry. Generous, because this is a local server and a slow answer is likelier
 * than a wedged one.
 */
const TIMEOUT_MS = 30_000;

function withTimeout(options: RequestInit): RequestInit {
  if (options.signal || typeof AbortSignal?.timeout !== 'function') return options;
  return { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) };
}

function describe(error: unknown): Error {
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error('Familiar could not reach its local server. Is it still running?');
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function request(path: string, options: RequestInit = {}): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...withTimeout(options),
    });
  } catch (error) {
    throw describe(error);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || 'Something went wrong.');
  }
  return response.status === 204 ? null : response.json();
}

/**
 * Uploads must not set Content-Type: the browser has to supply the multipart
 * boundary itself, and naming the type by hand omits it.
 */
async function sendFile(path: string, file: File, extra: Record<string, string | undefined> = {}): Promise<any> {
  const body = new FormData();
  body.append('file', file);
  for (const [key, value] of Object.entries(extra)) if (value) body.append(key, value);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, withTimeout({ method: 'POST', body }));
  } catch (error) {
    throw describe(error);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || 'Something went wrong.');
  }
  return response.json();
}

/** Provenance for the import log, since the server no longer sees the file. */
async function checksum(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Portraits are served as static files, so the URL is just a path. */
function withPortrait(card: any): Card {
  return { ...card, portrait_url: card.image_path ? `/assets/${encodeURI(card.image_path)}` : null };
}

export class HttpStore implements Store {
  async listCourses(): Promise<Course[]> {
    return request('/courses');
  }

  async getCourse(courseId: string): Promise<Course> {
    return request(`/courses/${courseId}`);
  }

  async listCards(courseId: string): Promise<Card[]> {
    const cards = await request(`/courses/${courseId}/cards?sort=first`);
    return cards.map(withPortrait);
  }

  async listCandidates(courseId: string): Promise<Card[]> {
    const cards = await request(`/courses/${courseId}/candidates`);
    return cards.map(withPortrait);
  }

  async getCourseStats(courseId: string): Promise<CourseStats> {
    return request(`/courses/${courseId}/stats`);
  }

  async getCardHistory(courseId: string, cardId: string) {
    const body = await request(`/courses/${courseId}/cards/${cardId}/history`);
    return body.events;
  }

  /** Reports extraction progress, which happens here rather than on the server. */
  onExtractionProgress: ((progress: ExtractionProgress) => void) | null = null;

  async createCourseFromRoster(file: File, title?: string): Promise<ImportOutcome> {
    return this.sendRoster('/courses', file, title);
  }

  async importRosterIntoCourse(courseId: string, file: File): Promise<ImportOutcome> {
    return this.sendRoster(`/courses/${courseId}/imports`, file);
  }

  /**
   * Read the roster here, then send what came out of it.
   *
   * The PDF never travels. Reading it in the page is faster than the native
   * path was, and it keeps a file of student photographs on the machine it was
   * chosen on even though a server is involved.
   */
  private async sendRoster(path: string, file: File, title?: string): Promise<ImportOutcome> {
    const { people, pages } = await extractRoster(file, (progress) => this.onExtractionProgress?.(progress));

    const body = new FormData();
    const described = people.map((person, index) => ({
      first_name: person.first_name,
      last_name: person.last_name,
      portrait: person.portrait ? index : null,
    }));
    for (const person of people) {
      if (person.portrait) body.append('portraits', person.portrait, 'portrait.jpg');
    }
    // Indices must point into the portraits actually appended, not into people.
    let portraitIndex = 0;
    for (const [index, person] of people.entries()) {
      described[index]!.portrait = person.portrait ? portraitIndex++ : null;
    }

    body.append('people', JSON.stringify(described));
    body.append('source_filename', file.name);
    body.append('source_checksum', await checksum(file));
    body.append('pages', String(pages));
    if (title) body.append('title', title);

    let response: Response;
    try {
      response = await fetch(`/api${path}`, withTimeout({ method: 'POST', body }));
    } catch (error) {
      throw describe(error);
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || 'Something went wrong.');
    }
    return response.json();
  }

  async addCard(courseId: string, person: { first_name: string; last_name: string; facts: string[] }) {
    return request(`/courses/${courseId}/cards`, { method: 'POST', body: JSON.stringify(person) });
  }

  async approveCandidate(courseId: string, cardId: string): Promise<void> {
    await request(`/courses/${courseId}/candidates/${cardId}/approve`, { method: 'POST' });
  }

  async rejectCandidate(courseId: string, cardId: string): Promise<void> {
    await request(`/courses/${courseId}/candidates/${cardId}`, { method: 'DELETE' });
  }

  async removeCard(courseId: string, cardId: string): Promise<void> {
    await request(`/courses/${courseId}/cards/${cardId}`, { method: 'DELETE' });
  }

  async resetCourseProgress(courseId: string, confirmTitle: string): Promise<void> {
    await request(`/courses/${courseId}/reset`, {
      method: 'POST',
      body: JSON.stringify({ confirm_title: confirmTitle }),
    });
  }

  async startSession(courseId: string, mode: StudyMode, cardIds: string[]): Promise<{ id: string }> {
    return request(`/courses/${courseId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ mode, card_ids: cardIds }),
    });
  }

  async recordReview(sessionId: string, review: ReviewRecord): Promise<void> {
    await request(`/sessions/${sessionId}/reviews`, { method: 'POST', body: JSON.stringify(review) });
  }

  async completeSession(sessionId: string, readiness: number | null): Promise<SessionSummary> {
    return request(`/sessions/${sessionId}/complete`, { method: 'POST', body: JSON.stringify({ readiness }) });
  }

  async downloadExport(courseId?: string, options: { includeProgress?: boolean } = {}): Promise<void> {
    const base = courseId ? `/api/courses/${encodeURIComponent(courseId)}/export` : '/api/export';
    const url = options.includeProgress === false ? `${base}?include_progress=false` : base;
    // The server already sets a filename in Content-Disposition, so following
    // the link is enough; no need to fetch the archive into the page first.
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async importBundle(file: File): Promise<RestoreCounts> {
    return sendFile('/import/bundle', file);
  }
}
