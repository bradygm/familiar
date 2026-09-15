/**
 * Choosing a store.
 *
 * The build decides, not the running app, so the hosted bundle carries no HTTP
 * client and the local bundle carries no IndexedDB code. `FAMILIAR_STORE` is
 * replaced at build time; with no bundler in play yet it falls back to the HTTP
 * store, which is what the local build wants anyway.
 */
import { HttpStore } from './http.js';
import { IndexedDbStore } from './indexeddb.js';
export function createStore(kind = 'http') {
    switch (kind) {
        case 'http':
            return new HttpStore();
        case 'indexeddb':
            return new IndexedDbStore();
    }
}
export { HttpStore } from './http.js';
export { IndexedDbStore } from './indexeddb.js';
export { readZip, writeZip, crc32 } from './zip.js';
export { extractRoster } from './roster-extract.js';
//# sourceMappingURL=index.js.map