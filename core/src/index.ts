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

export {
  NEVER_REVIEWED_DAYS,
  daysSince,
  parseIsoInstant,
  toInstant,
  type Instant,
} from './time.js';

export {
  FAMILIAR_MASTERY,
  MAX_MASTERY,
  MAX_RECALL,
  MAX_STABILITY_DAYS,
  MIN_MASTERY,
  MIN_RECALL,
  MIN_STABILITY_DAYS,
  cardPredictedRecall,
  DIFFICULTY_SMOOTHING,
  courseReadiness,
  learningDifficulty,
  learningStatus,
  predictedRecall,
  selectionScore,
  summariseCourse,
  updateMemoryState,
  type CardHistory,
  type CardProgress,
  type CourseSummary,
  type MemoryState,
  type ReviewResult,
} from './model.js';

export { adaptiveCards, type AdaptiveOptions, type Random } from './selection.js';

export {
  ContinuousSession,
  type ContinuousCard,
  type ContinuousOptions,
  type ContinuousStats,
} from './continuous.js';

export { sortRoster, type RosterCard, type RosterSort } from './roster.js';

export {
  personKey,
  splitNewPeople,
  type ImportSplit,
  type NamedPerson,
} from './import.js';

export {
  HttpStore,
  IndexedDbStore,
  createStore,
  readZip,
  writeZip,
  type Card,
  type CardProgressRow,
  type Course,
  type CourseStats,
  type ImportOutcome,
  type ReviewOutcome,
  type RestoreCounts,
  type ReviewRecord,
  type SessionSummary,
  type Store,
  type StoreKind,
  type StudyMode,
} from './store/index.js';
