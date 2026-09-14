# Flashcards Web App - Product Plan

## Project snapshot

**Status:** requirements revised for a local, technical-user application; no application code has been started.

**Current source material:** `data/ME_EN_275_W26.pdf` and `data/ME_EN_497_W26.pdf`. These are the first ingestion test fixtures; future terms will add one PDF per course.

**Product goal:** a polished, simple web app for learning people and their details from course-specific source PDFs. A learner can browse a roster, study cards, mark answers right or wrong, and resume from progress saved on their own device.

## Recommended first release

Build a **local-first web app** with a small backend, a local SQLite database, and a browser UI. Run it through Docker Compose by default, with a documented native-development option for contributors. This project is aimed at technical users who are comfortable running a local service; it is not designed for public hosting in v1.

Use a single application service: a Python API (FastAPI is a good fit) serves the REST API and compiled/static frontend, reads PDFs during import, and writes to SQLite. The UI can use HTML, modern JavaScript modules, and Tailwind CSS. This gives us good visual primitives while keeping the runtime simple. Do not depend on a heavy UI component library for v1.

The default user command should be as small as:

```bash
docker compose up --build
```

SQLite and imported image/data files live in a named Docker volume or a clearly documented local `app-data/` directory, so recreating the application container does not erase study history. A native path (for example, `uv run ...`) is useful for contributors but does not need to be the primary onboarding path.

### Why this architecture

| Need | Decision |
| --- | --- |
| Local persistence without browser storage | SQLite database stored outside the disposable app container. |
| Easy local setup | Docker Compose is the default; native development remains possible. |
| Multiple courses | A course is imported from each PDF and studied independently. |
| PDF intake | Backend import pipeline extracts candidate data/images, then saves reviewed records locally. |
| Course and study history | Normalized local tables, queried by the API. |
| Backup / portability | A database backup/export command; optional JSON export later. |

## Important product decisions

1. **PDFs are imported locally.** The backend parses a selected PDF, saves extracted candidate records and images in local application storage, and provides a review step before cards become studyable. The PDF itself remains a local source artifact.
2. **Course data is versioned.** Give every course and card a stable ID. This preserves history when card wording or images change after a re-import.
3. **SQLite is the source of truth.** The browser is a client, not the persistence layer. Progress, cards, sessions, and import metadata live in the local database.
4. **Sessions are adaptive but never gated by dates.** There are no mandatory due dates and no "nothing to study" state. The app should always make an intelligent selection when the learner begins a session.
5. **No hosting in v1.** The app and its class data run only on the user's machine. If public or shared hosting is considered later, reevaluate privacy and permission first.

## User experience

### Core screens

1. **Course picker** - choose a course/semester, see card count and last study time.
2. **Roster list** - searchable list view for first exposure. Sort by first or last name; show thumbnail, full name, and a small set of safe facts.
3. **Study setup** - choose `All cards` or `Adaptive review`; display the number of cards available and an estimated session size.
4. **Study session** - one distraction-free card at a time. The front is usually a photo/prompt; the back identifies the person and relevant facts. The learner flips, then marks the response right or wrong. A learner who already knows the name can mark it right without flipping first.
5. **Session summary** - reviewed, correct, incorrect, accuracy, and a concise learning summary.
6. **Progress and data** - per-course totals, recent sessions, reset course progress, import status, and local backup/export.

### Keyboard controls

Show these controls on screen and provide clickable equivalents for touch devices:

| Key | Action |
| --- | --- |
| `Space` or `Enter` | Flip card |
| `R` | Mark right (before or after flip) |
| `W` | Mark wrong (only after flip) |
| `Esc` | End the session and show its summary |
| `?` | Show shortcut help |

The asymmetry is deliberate. `R` is a fast path for a learner who already knows the name and gains nothing from the reveal, so the study screen offers it alongside `Flip card`. `W` stays behind the flip, because a learner who missed a person should always see who it was before the session moves on.

Avoid intercepting shortcuts while a search field or other text input has focus. Buttons must remain accessible with keyboard focus and screen readers.

## Data model

The importer writes to SQLite. Keep any original PDFs under `data/` and store extracted/optimized images in local application storage. A reviewed JSON export may be useful for debugging, but it is not the runtime source of truth.

Start with these tables:

| Table | Purpose / essential fields |
| --- | --- |
| `courses` | Stable ID, title, source filename, imported time, source checksum, active status. |
| `cards` | Stable ID, course ID, first name, last name, prompt type/content, answer/facts, image path, review status. |
| `import_runs` | Source file, checksum, started/finished time, extraction warnings, counts, and parser version. |
| `card_progress` | Card ID, seen/right/wrong counts, mastery (recent recall evidence), stability in days, last reviewed timestamp, last result. |
| `study_sessions` | ID, course ID, mode, start/end times, selected/reviewed/right/wrong counts. |
| `review_events` | Session ID, card ID, timestamp, result, and optional elapsed time. |

The import process must be repeatable and safe: calculate a PDF checksum, create an import run, extract candidate content, let the user correct/approve it, and avoid silently duplicating cards when the same PDF is re-imported.

## Adaptive sessions v1

The learner selects a course and either `All cards` or `Adaptive review`. They may start at any time; there are no due cards or deadlines.

For adaptive review, choose a varied session based on these priorities:

1. Give unseen cards high priority, particularly early in a course.
2. Revisit recently missed or low-predicted-recall cards, but do not repeat one immediately unless the learner asks for a drill.
3. Mix in a smaller number of well-known cards so names remain familiar and mastery estimates are refreshed.
4. Use time since last review as a gentle weighting signal, never a deadline or eligibility rule.
5. Randomize within comparable scores to avoid a predictable order.

Each card tracks two model values: `mastery` (recent recall evidence) and `stabilityDays` (how quickly recall decays). Predicted recall falls smoothly with time since review; it ranks the adaptive session but never makes a card unavailable. A right answer increases both values, while a wrong answer decreases both more sharply. The scheduler targets a practical blend of unfamiliar/weak people and familiar people, with a configurable session length.

`All cards` includes every active card once in a randomized order and still updates mastery/stability and statistics. `Expanding recall` selects a mastery/stability-biased base set, then uses in-session expanding retrieval gaps (3 then 7 cards after correct recalls; 2 after a miss), capped at four attempts per base card and 60 attempts total. A future `Refresh` mode can deliberately emphasize cards not seen for a long time without describing them as overdue.

## Scope boundaries for v1

Include:

- Course picker and independently studyable courses.
- Local PDF import, extraction diagnostics, and a review/approval step.
- Roster search and sorting by first/last name.
- Card flip, right/wrong actions, shortcuts, and session summary.
- SQLite-backed progress, basic statistics, sessions, reset, and backup/export.
- Responsive, accessible visual design.
- A documented, human-reviewable conversion workflow for each PDF.

Defer:

- User accounts, cloud sync, and hosted deployment.
- Collaborative editing, class-wide analytics, and leaderboards.
- Fully automatic PDF-to-card publishing without human review.
- Sophisticated multi-grade recall controls.
- Native mobile apps.

## Implementation plan and progress

- [x] Revise architecture to a local Docker/native application with SQLite persistence.
- [x] Define no-deadline adaptive-session behavior in place of due-date scheduling.
- [x] Add the two supplied PDFs as ingestion test fixtures.
- [ ] Inspect both PDFs and define exactly which fields/images form a card.
- [x] Build a basic PDF importer with extraction diagnostics, candidate review/approval, and checksum-based re-import protection.
- [x] Add local portrait extraction and course-specific image handling for the supplied roster layout.
- [ ] Create a small verified dataset from each PDF to test the importer and course separation.
- [x] Scaffold Docker Compose, the API, SQLite migrations, UI shell, and custom design tokens.
- [x] Build the course picker and roster list with search and first/last-name sorting.
- [x] Build the study setup and all-cards session flow.
- [x] Add SQLite persistence, statistics, and session history.
- [x] Add a portable backup/export bundle with a verified restore path.
- [x] Add course-progress reset.
- [x] Add a way to remove somebody who dropped the class.
- [x] Implement the adaptive-session selector with module-level checks.
- [x] Replace the fixed confidence score with a mastery/stability recall model and add a capped expanding-retrieval session mode.
- [ ] Add responsive/accessibility QA, empty states, error handling, and sample-data safeguards.
- [x] Write the local run and course-importing guide.
- [x] Write the local backup guide.
- [x] Pin the learning model with golden vectors before extracting a shared core.
- [x] Extract the learning model into a shared TypeScript core (see docs/PUBLIC_RELEASE_PLAN.md).
- [x] Make the backend storage-only: the client computes, the server stores.

## Proposed project layout

```text
flashcards/
  data/                         # local raw source PDFs
  app-data/                     # gitignored local database and derived assets
  backend/
    app/
      api/
      importers/
      models/
      study/adaptive_selector.py
    migrations/
    requirements.txt
  frontend/
    src/
    styles/
  tests/
  docker-compose.yml
  Dockerfile
  docs/IMPORTING_COURSES.md
  PROJECT_PLAN.md
```

## Acceptance criteria for the first release

- A local user can start the complete application with Docker Compose and retain data across container recreation.
- A local PDF can be imported, reviewed, and saved as a separate course without exposing its data to the network.
- The roster search works and first-name / last-name sorts are deterministic.
- A session can be started in both modes, controlled with both buttons and the documented keys.
- A card cannot be marked wrong before it is revealed; marking it right early is a deliberate shortcut for a name the learner already knows.
- Results persist after a refresh, container restart, and are isolated by course.
- The summary and statistics agree with the recorded answers.
- A local backup/export can restore the course statistics after a fresh setup.
- The app works at narrow mobile widths, with keyboard navigation, visible focus, sufficient contrast, and reduced-motion support.
- An adaptive session always selects a useful mixture; no card is ever blocked solely because it is not "due."

## Open questions to resolve before implementation

1. What content does the course PDF contain: names only, photos, bios, or other fields?
2. Should a card prompt be a photo, a name-to-facts question, both directions, or selectable per course?
3. Is each PDF text-based, image-based, or mixed? This determines the extraction/OCR approach.
4. Should the importer be an in-app upload, a command-line command that scans `data/`, or both?
5. Should backups be a raw SQLite file, a portable JSON archive, or both?

## Immediate next step

Inspect both supplied PDFs, identify their extractable card fields and images, then prototype the importer against a small reviewed subset from each course. That will validate the local data model before the interface is built around it.

## Future features
* Add my personal logo?
* ~~A way to remove people that drop the class later~~ Done: Course data → Remove someone who left, which also deletes their portrait.
* make version that hosted on my website and usable by others? Upload only, etc? Planned in docs/PUBLIC_RELEASE_PLAN.md — static GitHub Pages build for others, SQLite kept for local use. 
* Add ability to add new people, but it checks for duplicates. Like when a person adds the class, can I just upload a new pdf and it will just bring in the new people. 
* Calibrate the memory-model coefficients from local timestamped review data after several courses provide enough responses; validate predictions before treating them as calibrated probabilities.
* ~~Bug: in expanding recall mode, at the end it says "You reviewed 31 people" for example, but it actually was less people because some were shown multiple times.~~ Fixed: the summary now reports attempts and distinct people separately.
* ~~Continuous mode that just continues to adapt and sample.~~ Done: re-ranks after every answer, and a miss enters an expanding-retrieval cycle (2, then 3, then 7 intervening reviews) until recalled three times running.
* ~~Sort by those that were the hardest vs easiest to learn.~~ Done: damped misses per sighting, so thin evidence does not outrank a long difficult record.
* ~~Sort by familiar score (strength?)~~ Done: "Learning strength (low first)", which is the stored estimate before time decay.
* repo name change if going to be hosting? Maybe just call repo familiar, but readme have the full name?
* add google analytics 
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ZKRH21WV3V"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-ZKRH21WV3V');
</script>
* for web version, it needs to be self explanitory or instructions online. They won't have the readme. 
* ~~Awaiting review: this detail shouldn't be on the header...~~ Done: the header reads "N people", and the review button appears only when there are names, labelled with the count.