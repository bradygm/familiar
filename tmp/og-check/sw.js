/**
 * Offline support for the hosted build.
 *
 * A study tool is used in odd places — a corridor before class, a building with
 * no signal — so it should not stop working when the network does. Nothing here
 * touches a learner's data: courses, portraits and history live in IndexedDB,
 * and this only caches the application itself.
 *
 * The shell is precached because it is small and needed immediately. The OCR
 * engine and its language data are not: together they are most of the app's
 * weight and are only wanted when somebody imports a roster, so they are cached
 * the first time they are actually fetched rather than downloaded on a first
 * visit that may never import anything.
 */

const VERSION = 'familiar-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/core/index.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)))),
  );
});

self.addEventListener('message', (event) => {
  // The page asks for this only after telling the learner an update is ready.
  if (event.data === 'activate-update') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const save = (response) => {
    // Only cache what came back whole; a partial or error response cached here
    // would be served in its place indefinitely.
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  };

  // The page and its code go to the network first, falling back to the cache
  // when offline. Cache-first would be faster, but it would also mean a bad
  // deploy stayed on somebody's screen until the cache version changed — and
  // with no way to reach the fixed version, that is a site nobody can recover.
  // Network-first heals itself the moment the network is back.
  const isShell = request.mode === 'navigate' || /\.(html|js|css|webmanifest)$/.test(url.pathname);
  if (isShell) {
    event.respondWith(
      fetch(request)
        .then(save)
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match('./'))),
    );
    return;
  }

  // Everything else — the OCR engine, its language data, the icon — is static
  // and large, so it is served from the cache once it has been fetched.
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then(save)));
});
