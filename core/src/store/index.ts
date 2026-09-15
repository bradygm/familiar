/**
 * Choosing a store.
 *
 * The build decides, not the running app, so the hosted bundle carries no HTTP
 * client and the local bundle carries no IndexedDB code. `FAMILIAR_STORE` is
 * replaced at build time; with no bundler in play yet it falls back to the HTTP
 * store, which is what the local build wants anyway.
 */

import { HttpStore } from './http.js';
import type { Store } from './types.js';

export type StoreKind = 'http' | 'indexeddb';

export function createStore(kind: StoreKind = 'http'): Store {
  switch (kind) {
    case 'http':
      return new HttpStore();
    case 'indexeddb':
      throw new Error('The browser store arrives with the static build; see docs/PUBLIC_RELEASE_PLAN.md.');
  }
}

export { HttpStore } from './http.js';
export type {
  Card,
  CardProgressRow,
  Course,
  CourseStats,
  ImportOutcome,
  ReviewOutcome,
  ReviewRecord,
  SessionSummary,
  Store,
  StudyMode,
} from './types.js';
