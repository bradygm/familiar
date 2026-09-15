# Public release plan

How to turn Familiar from a personal Docker app into something other people can use,
without ever holding anyone else's student data.

## The short answer

1. **Host it as a static, browser-only app on GitHub Pages.** No server, no accounts,
   no database you operate. Every roster stays in the visitor's browser.
2. **Keep SQLite on disk for your own instance.** The public build and your build share
   one codebase and differ only in a storage adapter. You do not give up your database.
3. **You do not need to finish the features first, and you should not.** Only a small
   slice of the remaining work is at risk of being written twice, and it is identifiable.
4. The architecture is *mostly* shareable already — much more than it looks.

## Why the architecture is already close

The frontend touches the backend in exactly two places:

| Seam | Location | Becomes |
| --- | --- | --- |
| `api(path, options)` — the only `fetch` in the app | `frontend/app.js:7` | A local dispatcher mapping the same paths to in-browser functions |
| `portraitUrl(card)` — builds `/assets/<path>` | `frontend/app.js:14` | `URL.createObjectURL(blob)` from local storage |

Everything else in `app.js` — rendering, the expanding-recall state machine
(`app.js:145-170`), keyboard handling, the session summary — is already client-side and
knows nothing about SQLite or HTTP. Because `api()` keeps its signature, the same UI can
run against either backend during the migration, behind a one-line switch.

### Layer audit

| Layer | Where it lives | Portable to a static app? |
| --- | --- | --- |
| Learning model & selection | `backend/app/study.py` (pure, no IO) | **Yes** — direct line-for-line port |
| Expanding-recall scheduling | `frontend/app.js` | **Already there** — no port needed |
| UI / rendering | `frontend/` | **Yes** — two functions change |
| Persistence | `database.py` + SQL inside `main.py` | **No** — replaced by IndexedDB |
| HTTP transport | `main.py` routes | **Deleted** — becomes direct calls |
| PDF import / OCR | `importer.py` + poppler + tesseract | **Rewritten** for the browser |

Two of six layers change. That is the real scope.

One live symptom of the missing seam: `predicted_recall` is implemented **twice** today —
Python at `study.py:16` and JavaScript at `app.js:19`. They currently agree. They will not
agree forever. Extracting one shared core deletes that class of bug.

## Storage durability, and why you keep SQLite

### What actually clears IndexedDB

| Action | IndexedDB cleared? |
| --- | --- |
| Chrome/Edge "Clear browsing data" → *Cached images and files* | No |
| Chrome/Edge/Firefox → *Cookies and other site data* | **Yes** |
| Safari → *Clear History and Website Data* | **Yes** |
| Safari: 7 days with no visit, site not installed or persisted | **Yes** |
| Disk-pressure eviction while storage is "best-effort" | **Yes** |
| `navigator.storage.persist()` granted | Exempt from *automatic* eviction; an explicit clear still wipes it |
| Private / incognito window | Gone when the window closes |

So a routine cache clear does **not** touch it — that part of the worry is unfounded. But
a site-data clear, a Safari history clear, or a quiet ITP eviction does. IndexedDB is a
good cache of user-owned data and a bad system of record. That is an acceptable trade for
a visitor who can re-import a PDF in two minutes. It is not an acceptable trade for
several semesters of your own review history, which is unreproducible.

### Two deployments, one codebase

Do not pick one storage engine. Make storage the adapter behind the `api()` seam, and
build two:

| | Public build | Your build |
| --- | --- | --- |
| Hosting | GitHub Pages, static | `docker compose up`, as today |
| Storage adapter | `IndexedDbStore` | `HttpStore` → FastAPI → SQLite |
| System of record | Visitor's browser | `app-data/flashcards.sqlite3` on your disk |
| Durability | Persist + PWA install + backup nagging | A real file: Time Machine, `sqlite3` CLI, `cp` |
| Import | `pdf.js` + `tesseract.js` in the page | the same, and no server-side OCR at all |
| Learning model | Shared TypeScript core | Shared TypeScript core |

The important part: **the HTTP adapter is code you already have.** `api()` at
`frontend/app.js:7` *is* that adapter today, unchanged. Your instance is the one that
moves the least in this whole plan.

### What this does to the Python backend

It shrinks, and that is the point. The learning model moves to the shared TypeScript core,
so `backend/app/study.py` is not ported — it is **deleted**, and FastAPI stops computing
mastery. What remains is CRUD over SQLite, the PDF importer, and static assets. The
client computes, the server stores.

This removes the duplication problem rather than managing it. There is one implementation
of `predicted_recall` in the repository, both builds run it, and there is no parity suite
to maintain because there is nothing to keep in parity.

The one real change in character: the server trusts computed values from the client. For a
single-user app bound to localhost, that is not a security property you had anyway.

### A third option, if you ever want to drop the server

The File System Access API lets a browser hold a persistent handle to a real directory
(`~/Documents/Familiar/`) and write the database and portraits there. The handle lives in
IndexedDB, but **the data does not** — so clearing site data costs you one folder re-pick,
not your history. It is Chrome/Edge desktop only; Safari and Firefox do not support the
directory picker with write access. Worth knowing about, not worth building now, and
strictly worse than the SQLite file you already have.

### Backups either way

`app-data/` is gitignored, so Git is not protecting your database. Whichever path you take,
the Phase 0 export format plus a periodic copy of the SQLite file is the actual safety net.
Persistence settings reduce the odds of loss; they do not replace a backup.

### One tradeoff to name

The local-server build is desktop-only, because it is served from localhost. That is
already true today, so it is not a regression — but it means phone study only exists on
the static build. Treat the SQLite file as the single source of truth and the phone as a
read-mostly copy you refresh by export; do not attempt two-way sync.

## Hosting options considered

| Option | Privacy | Setup friction for others | Verdict |
| --- | --- | --- | --- |
| **A. Static browser app on GitHub Pages** | Perfect — data never leaves the device, and you are not a data processor | Open a URL | **Recommended, for other people** |
| **B. Keep Docker + SQLite** | Perfect | Install Docker, clone a repo, run a command | **Recommended, for you** — too much friction to ask of other instructors, exactly right for the one user who wants a durable file |
| C. Hosted app with accounts and a server DB | **You would store other people's student photos** | Lowest | **Rejected** — unacceptable liability for a roster app |
| D. Static study app + optional local Python importer producing a portable bundle | Perfect | Open a URL; power users install the CLI | **Keep as the documented fallback** if in-browser OCR underperforms |

A and B are not competing answers. They are the same application with two storage
adapters, per the section above. C is worth naming explicitly so it stays rejected.

The moment you accept an upload of a roster PDF, you are holding identifiable student
photos for institutions you have no relationship with. A static site sidesteps that entirely: there is no upload endpoint to
subpoena, breach, or misconfigure.

A desktop wrapper (Tauri/Electron) was considered and dropped — an installable PWA gives
the same offline behaviour with none of the packaging and signing work.

## What to build before the port, and what to hold

### Do now — these carry over for free

1. **Golden test vectors for the learning model.** Freeze a JSON fixture of
   inputs to `predicted_recall`, `update_memory_state`, `adaptive_cards` and
   `course_readiness`, plus their current outputs. This is the safety net that makes the
   port provably behaviour-preserving rather than hopefully behaviour-preserving.
   Highest value item on this list.
2. **Portable export format (zip: `course.json` + `assets/*.jpg`).** This single piece of
   work closes the outstanding "backup/export" item, becomes the migration path for your
   own semester of real progress, and doubles as the roster-sharing format later.
3. **Fix the expanding-recall miscount.** The summary reports attempts as people
   (`PROJECT_PLAN.md` known bug). It lives in the shared client code, so fixing it now
   means fixing it once.
4. **Course reset and "remove a person who dropped."** Small, and the semantics you decide
   now survive the storage swap even though the SQL does not.

### Hold until the core is extracted — otherwise you write them twice

- Continuous / never-ending adaptive mode
- Sort by hardest-to-learn, easiest, and learning strength
- Calibrating the memory-model coefficients from real review data
- Re-import de-duplication and adding new students mid-semester
- Accessibility and responsive QA, empty states, error handling
- Your logo

The deferred list is not "do it later." It is "do it once, in the shared core, where it is
headlessly testable." Continuous mode in particular is pure scheduling logic — it can be
written and tested with no UI at all.

## Phases

### Phase 0 — Freeze behaviour
Golden vectors, portable export, the miscount fix, reset/remove. Ship on the current
Docker app. Nothing architectural yet.

### Phase 1 — Extract the core — **done**
Restructure to `core/` (pure TypeScript: model, selection, scheduling — no DOM, no IO),
`web/`, `backend/`. Port `study.py` and verify against the Phase 0 vectors with Vitest,
then delete it and the duplicated JS `predicted_recall`. FastAPI stops computing mastery
and starts accepting it; the app keeps running on SQLite throughout.

### Phase 2 — Finish the learning features in the core — **next**
Continuous mode, the new sorts, calibration groundwork. All headless, all test-driven,
all written exactly once. This is where "the couple of last features" actually land.

### Before Phase 3 — finish the write surface
The `Store` interface should be extracted once, against the complete set of operations,
rather than amended each time a new write appears. Two writes are still missing, both
small and both already on the backlog:

- **Course-progress reset** — the last unchecked item from Phase 0.
- **Removing somebody who dropped the class** — currently only possible by editing the
  database by hand.

Neither is hard. The reason to do them first is that each adds a method to an interface
that does not exist yet; adding them after means changing both implementations instead of
one.

Phase 3 itself should then also add **bundle import in the app**. Phase 0 built the export
and a restore CLI, but nothing in the browser can read a bundle back — and that is how an
`IndexedDbStore` gets populated before browser OCR exists in Phase 4, and how the local
database migrates into it.

### Phase 3 — The storage adapter seam — **done**
Formalise `api()` into a `Store` interface with two implementations: the existing
`HttpStore` (extracted as-is, keeps your SQLite) and a new `IndexedDbStore`
(`courses`, `cards`, `progress`, `sessions`, `reviews`, `assets` as Blobs). Do the same
for `portraitUrl()` — a path under the server, a blob URL in the browser. Selected at
build time, so the public bundle contains no HTTP client and your build contains no
IndexedDB code. Validate the new adapter by loading your Phase 0 export into it; your
own daily use never leaves SQLite.

### Phase 4 — Import in the browser — **done**

Measured on a real 58.9 MB, 23-page scanned export: **3.6 seconds in the browser against
25 seconds natively in Docker**, finding all 69 people with a portrait each. The two
extractors agree exactly on that file. This reverses the assumption recorded below that
browser OCR would be the slow path — it is roughly seven times faster, because the native
importer shells out to `pdftoppm` to rasterise every page to a temporary PNG first, while
pdf.js rasterises straight to a canvas already in memory.

That removes the tradeoff this phase was expected to weigh. The TypeScript extractor can
replace the Python one everywhere: one extractor, no drift, and an image with no poppler
or tesseract in it.
`pdf.js` replaces `pdftoppm`; `tesseract.js` replaces `pytesseract` — same engine, so the
crop fractions and `--psm` modes in `importer.py` port directly. Run it in a Web Worker
with a progress bar. `importer.py` stays exactly where it is for your build, using the
native binaries that are faster and already working. This is additive, not a migration.

### Phase 5 — Ship the public build
GitHub Pages via Actions, PWA + service worker, `navigator.storage.persist()`, backup
prompting, a demo course with synthetic faces, and accessibility and error-handling QA.
Custom domain if you want it on your own site — Pages supports one with HTTPS. Your Docker
build is unaffected by this phase and keeps working the whole time.

**The page has to explain itself.** A visitor arrives with no README: nothing tells them
what this is, which roster layout it supports, that their data stays on their device, or
what to do first. That is a launch requirement, not polish — a page that cannot answer
those questions has no usable audience, however good the study modes are. In particular
the privacy statement has to be *in the page*, because it is the thing that decides
whether an instructor is willing to load a roster of student photos at all.

Concretely: a landing state that says what it does in a sentence, the demo course reachable
without importing anything, the supported roster layout named plainly, and the privacy
statement visible without scrolling for it.

### Phase 6 — Reach beyond BYU — **optional**
Generic CSV + photos import, a stronger review/correct step for arbitrary layouts, logo.
See the generality note below.

This phase is severable, and worth being honest about: the audience is BYU faculty, who all
get the same roster layout from the same tool. Everything needed to serve them is done by
the end of Phase 5. Phase 6 only matters if the audience widens to instructors at other
institutions, and it is a large amount of work — a generic importer means supporting layouts
nobody has seen. Cutting it is a legitimate outcome, not a failure; nothing in Phases 0-5
depends on it.

## Risks worth designing around now

**Safari evicts IndexedDB after 7 days of no visits** (public build only — your SQLite
file is unaffected). For a study app used weekly, that is real data loss. Mitigate with
all three: call `navigator.storage.persist()`, prompt to install the PWA, and nag for a
backup export. This is the single most likely way a *visitor* loses a semester of
progress, and the reason the durability section above exists.

**Your OCR is BYU-Flashcards-specific.** `importer.py` hardcodes three name cells per page
at page-height fractions `0.216 / 0.435 / 0.655` and names in the right 55% of the page.
Nobody else's roster looks like that. The fix is not a smarter parser — it is a good
review-and-correct UI plus a generic CSV path, so imperfect extraction is recoverable for
any layout. Treat the PDF importer as one adapter among several, and say plainly in the
README which layout it supports.

**Tesseract language data is ~10-15MB.** Self-host it rather than pulling from a CDN — a
CDN request leaks that a visitor is importing something, which undercuts the privacy claim
you are making. Same for fonts. Well within Pages' limits.

**Pages cannot set HTTP headers,** so the Content-Security-Policy has to be a `<meta>` tag:
`default-src 'self'`, `connect-src 'self' https://*.google-analytics.com`,
`script-src 'self' https://www.googletagmanager.com`, plus `wasm-unsafe-eval` for the OCR
WASM. Worth doing — it still enforces that roster data has nowhere to go, since the only
permitted destinations are the origin itself and the analytics endpoint, and it keeps a
future dependency from quietly adding a third one.

Note what analytics costs here: a visitor can no longer confirm the privacy claim by
observing zero outbound requests. They will see requests to Google and have to trust that
those carry only a page view. That is a loss of *verifiability*, not of privacy, and it is
the reason the analytics is cookieless and the URL is trimmed — so the claim stays small
enough to be credible without proof.

**Service worker staleness.** Version the assets and show a visible "update available"
prompt, or returning users will sit on old builds.

**In-browser OCR speed.** Two full OCR passes per page today; the whole-page `--psm 6` pass
only feeds a diagnostic text blob. Drop it and OCR the right column alone to roughly halve
the work. Expect a minute or two per course in WASM, which is acceptable for a once-per-
semester operation with a progress bar. If it proves worse, Option D is the fallback.

## Privacy posture to state publicly

- Nothing is uploaded; the site has no backend, and no roster, portrait, name, or
  study result leaves the browser.
- The page records visit counts for internal use, via Google Analytics, with a
  first-party `_ga` cookie so repeat visits are distinguishable from new ones.
  Advertising signals are denied through Consent Mode. `page_location` is
  trimmed to origin plus pathname, because GA4 would otherwise send the hash
  route, which carries course ids. Analytics is skipped on `localhost`, so a
  local install makes no third-party requests.
- Measured behaviour, not assumed: one `page_view` per page load and none on
  hash navigation, and the reported location is the bare origin even when
  landing directly on `?query#/course/<id>`. Enhanced Measurement's history
  tracking does not fire for hash-only changes.
- **What would break that**, in rough order of how easy it is to do by accident:
  a dynamic `document.title` (GA sends it as `dt`, and "Jane Doe — Familiar"
  would go straight to Google; it is static today), adding SPA route tracking
  without re-applying the `page_location` trim, or custom events carrying names
  in their parameters. Keeping names out of URLs *and* out of the title is the
  cheap guardrail.
- Setting an analytics cookie is the thing that would require a consent banner
  for EU visitors. Not a concern for a BYU-facing tool today, worth revisiting
  before promoting it more widely. A cookieless configuration exists
  (`analytics_storage: 'denied'`) and was measured to report nothing useful at
  low traffic, which is why it was not kept.
- Storage is the visitor's browser; export is a manual file they control.
- Sharing a roster between instructors is deliberately *not* a hosted feature — export a
  bundle and send it however they already send sensitive files.
- A short note that users remain responsible for their institution's student-data rules.
- Add a line to the issue template telling people not to attach real roster PDFs.

Your repo is currently clean — only the two anonymized screenshots are tracked, and
`data/` and `app-data/` are ignored. Keep it that way.

## Acceptance criteria for the public release

- A visitor can open the URL, load the demo course, and study without importing anything.
- A visitor who has never seen the repository can tell, from the page alone, what it does,
  whether their roster is supported, and where their data goes.
- A visitor can import a supported roster, correct mistakes, and study — with devtools
  showing no outbound request carrying roster data, and no request at all beyond the
  single analytics page view.
- Closing the browser and returning a week later preserves progress, on a persisted or
  installed instance.
- Export produces a file that re-imports into a fresh browser profile with progress intact.
- The learning model produces identical output to the Phase 0 golden vectors, in both builds.
- Your own instance still stores everything in `app-data/flashcards.sqlite3`, readable with
  the `sqlite3` CLI, with no review history lost at any point in the migration.
