/**
 * Familiar's shared client library.
 *
 * The learning model — recall, mastery, selection, the import rule — is pure:
 * no DOM, no network, no database. The browser build and the local SQLite build
 * both compute from it, so a learner's stored mastery means exactly one thing
 * regardless of where it happens to be stored.
 *
 * `store/` is the deliberate exception, and the only one: it is where storage
 * lives, so that every other module can stay unaware of which build it is in.
 */
export { NEVER_REVIEWED_DAYS, daysSince, parseIsoInstant, toInstant, } from './time.js';
export { FAMILIAR_MASTERY, MAX_MASTERY, MAX_RECALL, MAX_STABILITY_DAYS, MIN_MASTERY, MIN_RECALL, MIN_STABILITY_DAYS, cardPredictedRecall, DIFFICULTY_SMOOTHING, courseReadiness, learningDifficulty, learningStatus, predictedRecall, selectionScore, summariseCourse, updateMemoryState, } from './model.js';
export { adaptiveCards } from './selection.js';
export { ContinuousSession, } from './continuous.js';
export { DEMO_COURSE_ID, demoBundle } from './demo.js';
export { sortRoster } from './roster.js';
export { ROSTER_LAYOUT, readNameLine, readNames, } from './roster-text.js';
export { personKey, splitNewPeople, } from './import.js';
export { HttpStore, IndexedDbStore, createStore, extractRoster, readZip, writeZip, } from './store/index.js';
//# sourceMappingURL=index.js.map