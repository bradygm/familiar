# Backup and restore

Familiar keeps everything in `app-data/`, which is **ignored by Git**. Nothing in
your normal commit workflow protects your study history. This is how you protect it.

## What is at risk

| Path | Contents | Reproducible? |
| --- | --- | --- |
| `app-data/flashcards.sqlite3` | Courses, cards, mastery, sessions, every review event | **No** |
| `app-data/assets/` | Extracted portraits | Only by re-importing the original PDF |
| `data/*.pdf` | Source rosters | Only by re-exporting from BYU Flashcards |

The database is the irreplaceable part. A semester of review events cannot be
recreated by re-importing anything.

## Taking a backup

From the app's home page, under **Local backup**:

- **Export everything** — every course, portrait, and review event.
- **Export rosters only (no progress)** — the same people with no study history.
  Use this if you ever hand a roster to someone else.

Both download a single `.zip`. Per-course backups are on each course page under
**Export course**.

You can also take one without the app running:

```bash
sqlite3 app-data/flashcards.sqlite3 ".backup 'app-data/backups/flashcards-$(date +%Y%m%d).sqlite3'"
```

Keep at least one copy somewhere that is not this machine.

## What is in a bundle

A bundle is a zip holding `familiar-bundle.json` plus the portraits it references:

```text
familiar-bundle.json      schema, courses, cards, progress, sessions, review events
assets/<course-id>/*.jpg  portraits
```

It is plain JSON on purpose. A future browser-based build reads the same format
with no SQL engine, so a bundle taken today is not tied to SQLite.

## Restoring

Restore rebuilds a **new** database. It never merges into an existing one, and it
refuses outright if the target already contains the bundle's courses — a silent
merge is how divergent histories quietly lose reviews.

```bash
.venv/bin/python tools/restore_bundle.py backup.zip --into app-data/restored.sqlite3
```

Check the result before trusting it:

```bash
sqlite3 app-data/restored.sqlite3 "PRAGMA integrity_check; SELECT COUNT(*) FROM review_events;"
```

Then put it in place yourself:

```bash
mv app-data/flashcards.sqlite3 app-data/flashcards.sqlite3.old
mv app-data/restored.sqlite3 app-data/flashcards.sqlite3
```

The restore writes portraits next to the target database unless you pass `--assets`.

## Verifying that backups actually work

`tests/test_real_database_round_trip.py` exports your real database, restores it
into a throwaway copy, and compares every row and every portrait byte. It reads
the live database read-only and skips if there is no local database:

```bash
.venv/bin/pytest tests/test_real_database_round_trip.py -v
```

Run it after any change to the storage layer. A backup format you have never
restored from is not a backup.
