# Golden vectors

`study_vectors.json` pins the exact behaviour of Familiar's learning model:
626 cases covering `daysSince`, `predictedRecall`, `selectionScore`,
`updateMemoryState` and `courseReadiness`.

## Why this file exists

It was generated from the original Python implementation in
`backend/app/study.py`. The TypeScript core in `core/` was then verified against
it — including on the real local database, where 64 of 69 cards agreed bit for
bit and the rest to 1.1e-16 — before that Python file was deleted.

So this file is not just a regression test. It is the record that the port
preserved the meaning of every learner's stored `mastery` and `stability_days`.
Those numbers were accumulated over real study sessions and cannot be
recomputed from anything else.

It also contains timestamps with sub-millisecond precision, because stored
timestamps carry microseconds and JavaScript's `Date` resolves only
milliseconds. Any implementation that parses timestamps through `new Date(...)`
fails these cases rather than drifting quietly on real data.

## Changing the model

`core/tests/golden.test.ts` asserts against this file, so an accidental change
to a coefficient fails loudly — a 1e-10 change fails 120 cases.

To change the model *deliberately*, edit `core/src/`, then:

```bash
cd core && npm run vectors
```

The resulting diff is a reviewable statement of exactly how behaviour changed.
Regenerating replaces the Python provenance above with current TypeScript
behaviour, which is correct once a change is intended — but it means the file
stops witnessing the port, so do not run it casually.
