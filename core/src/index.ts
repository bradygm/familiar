/**
 * Familiar's learning model, shared by every build.
 *
 * Nothing in here touches the DOM, the network, or a database. The browser
 * build and the local SQLite build both compute from this module, so a
 * learner's stored mastery means exactly one thing regardless of where it
 * happens to be stored.
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
  courseReadiness,
  learningStatus,
  predictedRecall,
  selectionScore,
  summariseCourse,
  updateMemoryState,
  type CardProgress,
  type CourseSummary,
  type MemoryState,
  type ReviewResult,
} from './model.js';

export { adaptiveCards, type AdaptiveOptions, type Random } from './selection.js';
