import {
  ContinuousSession,
  adaptiveCards,
  cardPredictedRecall,
  courseReadiness,
  createStore,
  demoBundle,
  learningStatus as recallStatus,
  sortRoster,
  summariseCourse,
  updateMemoryState,
} from './vendor/core/index.js';

// Which store this is, is a build-time decision: tools/build-static.mjs rewrites
// this line when publishing the hosted build. Everything below is written
// against the interface, so the same UI serves both without knowing which it is
// in — and neither published bundle is asked to guess at runtime.
const store = createStore('http'); // STORE

const app = document.querySelector('#app');
let currentCourse = null;
let study = null;
let scoring = false;

/**
 * Show extraction progress, when the store does its reading in the page.
 *
 * The local build uploads and the server answers when it is done, so there is
 * nothing to report; the hosted build reads the PDF here and a silent wait would
 * read as a hang. Returns a function that puts the store back as it was.
 */
function reportExtraction(element) {
  if (!('onExtractionProgress' in store)) return () => {};
  store.onExtractionProgress = ({page, pages, found, stage}) => {
    if (stage === 'loading') { element.innerHTML = notice('Opening the roster…'); return; }
    if (stage === 'done') { element.innerHTML = notice(`Read ${pages} ${pages === 1 ? 'page' : 'pages'}, found ${found}. Saving…`); return; }
    const verb = stage === 'rendering' ? 'Rendering' : 'Reading';
    element.innerHTML = notice(`${verb} page ${page} of ${pages} · ${found} ${found === 1 ? 'person' : 'people'} so far`);
  };
  return () => { store.onExtractionProgress = null; };
}

function importSummary(result) {
  if (result.warning) return result.warning;
  const people = result.added === 1 ? 'person' : 'people';
  const skipped = result.already_present ? `, and ${result.already_present} already in the class` : '';
  return `Found ${result.found} on the roster: ${result.added} new ${people} to review${skipped}.`;
}
const esc = (value) => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const initials = (card) => `${card.first_name[0] || ''}${card.last_name[0] || ''}`.toUpperCase();
const courseLink = (course) => `#/course/${course.id}`;
// The store resolves this: a path under the server, or a blob URL in the browser.
const portrait = (card) => card.portrait_url ? `<img class="avatar portrait" src="${card.portrait_url}" alt="Portrait of ${esc(card.first_name)} ${esc(card.last_name)}">` : `<div class="avatar">${initials(card)}</div>`;
const studiedLabel = (timestamp) => timestamp ? `Last studied ${new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', year:'numeric'}).format(new Date(timestamp))}` : 'Ready to learn';
const shortDate = (timestamp) => timestamp ? new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric'}).format(new Date(timestamp)) : 'Not yet';
// The learning model lives in core/ and is shared by every build, so these are
// thin label wrappers rather than a second implementation. The previous local
// copy of the recall formula also truncated stored timestamps to milliseconds.
const STATUS_LABELS = {new: 'New', learning: 'Learning', familiar: 'Familiar'};
const learningStatus = (card) => STATUS_LABELS[recallStatus(card)];
const predictedRecall = (card) => cardPredictedRecall(card, Date.now());

function recallMeter(card) {
  if (!card.seen_count) return `<div class="recall-meter is-new"><div><span>Predicted recall</span><strong>New</strong></div><div class="recall-track"><i></i></div></div>`;
  const recall = Math.round(predictedRecall(card) * 100);
  const tone = recall >= 75 ? 'strong' : recall >= 40 ? 'building' : 'weak';
  return `<div class="recall-meter ${tone}"><div><span>Predicted recall today</span><strong>${recall}%</strong></div><div class="recall-track" role="progressbar" aria-label="Predicted recall today" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${recall}"><i style="width:${recall}%"></i></div></div>`;
}

async function preloadPortrait(card) {
  if (!card?.portrait_url) return;
  const image = new Image();
  image.src = card.portrait_url;
  if (image.decode) await image.decode().catch(() => {});
  else await new Promise(resolve => { image.onload = image.onerror = resolve; });
}

/**
 * Ask the browser to keep this data.
 *
 * Without persistent storage a browser may evict IndexedDB under disk pressure,
 * and Safari discards it after seven days without a visit — which for a tool
 * used once a week is a semester of review history gone. Asking is free and
 * usually granted silently once the app has been used or installed; it is
 * requested after the first class exists, when there is finally something worth
 * keeping and the browser has a reason to say yes.
 */
async function requestDurableStorage() {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted?.()) return;
    await navigator.storage.persist();
  } catch { /* Storage policy is the browser's to decide; nothing to do if it refuses. */ }
}

/**
 * Whether this browser deletes site data on a timer.
 *
 * WebKit's tracking prevention erases all script-writable storage — IndexedDB
 * included — after seven days of browser use without user interaction with the
 * site. That covers Safari on macOS and iOS, and every browser on iOS, because
 * they are all required to use WebKit: somebody running Chrome on an iPhone is
 * affected and will have no idea.
 *
 * It matters enormously here. Somebody studying once a week has a seven-day
 * budget and a seven-day cadence, which is no margin at all: one skipped week,
 * one exam period, one winter break, and a semester of review history is gone
 * with no warning and no recovery.
 *
 * Installing the app is the one documented exemption. Requesting persistent
 * storage is *not* reliably one — WebKit has carried an open bug about exactly
 * that since 2020, and developers have reported data deleted despite a granted
 * request, so this deliberately does not treat persistence as protection here.
 */
function storageExpiresOnATimer() {
  const agent = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const desktopSafari = /Safari/.test(agent) && !/Chrome|Chromium|Edg|OPR|Android/.test(agent);
  return iOS || desktopSafari;
}

/** An installed app keeps its own storage, and is exempt from that timer. */
function runningInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * How long to leave somebody alone between backup reminders.
 *
 * Pitched against how the data can actually be lost, rather than one interval
 * for everybody:
 *
 *   5 days  — browser storage that expires on a timer. A fortnightly reminder
 *             can otherwise arrive after the data it was protecting has gone.
 *   14 days — browser storage elsewhere. No timer, but a site-data clear takes
 *             it, and nothing warns first.
 *   30 days — a database file on this machine. It does not vanish on its own;
 *             it is still a single copy, but the risk is slow rather than sudden.
 */
function reminderIntervalDays() {
  if (store.kind !== 'indexeddb') return 30;
  return storageExpiresOnATimer() && !runningInstalled() ? 5 : 14;
}

/** Remember when a backup was last taken, so the reminder can be honest. */
const BACKUP_KEY = 'familiar:last-export';
function recordBackup() {
  try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch { /* private window */ }
}
function daysSinceBackup() {
  try {
    const last = localStorage.getItem(BACKUP_KEY);
    if (!last) return null;
    return (Date.now() - new Date(last).getTime()) / 86_400_000;
  } catch { return null; }
}

/**
 * A reminder to export, shown only when there is something to lose.
 *
 * This is not nagging for its own sake. Browser storage is a good cache and a
 * poor system of record: a site-data clear removes it, and what it would take
 * with it — timestamped review history — cannot be reconstructed from anything
 * else. A roster can be imported again in seconds; the record of how well
 * somebody knows each face cannot.
 */
function backupReminder(courses) {
  const reviews = courses.reduce((total, course) => total + (course.session_count || 0), 0);
  if (!reviews) return '';
  const since = daysSinceBackup();
  if (since !== null && since < reminderIntervalDays()) return '';
  const wording = since === null
    ? 'You have study history that has never been backed up.'
    : `It has been ${Math.floor(since)} days since your last backup.`;
  // Say what would actually take it. Warning somebody about browser storage
  // when their data is a file on their own disk is both wrong and, once they
  // notice, a reason to trust none of the other warnings either.
  const why = store.kind === 'indexeddb'
    ? 'It is kept in this browser, and clearing site data removes it without warning.'
    : 'It lives only in <code>app-data/flashcards.sqlite3</code> on this machine, which Git does not cover — if that file goes, so does it.';
  return `<div class="notice backup-reminder" role="status">${wording} ${why} Review history cannot be recreated. <button class="link-button" id="reminder-export">Export a backup now</button></div>`;
}

/**
 * The warning that matters most on this browser, and only where it applies.
 *
 * Not dismissible, because the risk does not go away until the app is
 * installed — and somebody who dismisses it and then loses a semester of work
 * has been failed by the dismissal, not helped by it. It disappears on its own
 * once the app is installed, which is the actual fix.
 */
function evictionWarning(courses) {
  if (!store.kind || store.kind !== 'indexeddb') return '';
  if (!courses.length || !storageExpiresOnATimer() || runningInstalled()) return '';
  const install = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.maxTouchPoints > 1
    ? 'Share → <strong>Add to Home Screen</strong>'
    : 'File → <strong>Add to Dock</strong>';
  return `<div class="notice warning" role="status"><strong>This browser deletes site data on a timer.</strong> Safari — and every browser on iPhone and iPad, which all run on Safari's engine — erases a site's stored data after about a week without visiting it. That would take your study history with it, without warning. Installing the app exempts it: ${install}. Either way, <button class="link-button" id="warning-export">keep a backup</button>.</div>`;
}

function setView(html) { app.innerHTML = html; }
function notice(message) { return `<p class="notice">${esc(message)}</p>`; }

/**
 * What a first-time visitor needs before anything else.
 *
 * Somebody arriving at the hosted page has no README and no other way to find
 * out what this is, whether their roster will work, or where their data goes.
 * That last question decides whether an instructor is willing to load a file of
 * student photographs at all, so it is answered on the first screen rather than
 * in a policy page nobody opens. Shown only until the first class exists.
 */
function orientation() {
  return `<section class="orientation panel">
    <div class="orientation-grid">
      <div>
        <div class="eyebrow">What this is</div>
        <p>A study tool for BYU instructors, for learning the names and faces of everyone in a class. You import the roster BYU already gives you, and it turns it into short practice sessions that concentrate on the people you keep missing.</p>
      </div>
      <div>
        <div class="eyebrow">What it reads</div>
        <p>The roster PDF exported by <a href="https://flashcards.byu.edu" target="_blank" rel="noreferrer">BYU Flashcards</a>, at <strong>3 students per page</strong>. Other layouts are not supported yet — the importer will tell you if it cannot find anyone rather than inventing people.</p>
      </div>
      <div>
        <div class="eyebrow">Where your data goes</div>
        <p><strong>Nowhere.</strong> The roster is read inside this page and never uploaded. Names, photos and your study history stay in this browser, on this device. Nobody else can see them — including whoever made this.</p>
      </div>
    </div>
    <div class="orientation-actions">
      <button class="button" id="load-demo">Try it with a demo class</button>
      <span class="fine">Twelve invented people with drawn avatars — no real students, nothing to upload.</span>
    </div>
    <div id="demo-message"></div>
  </section>`;
}

async function home() {
  setView(document.querySelector('#loading').innerHTML);
  const courses = await store.listCourses();
  setView(`
    <section class="hero"><div class="eyebrow">For BYU instructors</div><h1>Know every student<br>before the first day.</h1><p>Import your BYU course roster, confirm the people it finds, and build familiarity in short, adaptive sessions built on retrieval practice.</p></section>
    ${courses.length ? '' : orientation()}
    ${evictionWarning(courses)}
    ${backupReminder(courses)}
    <section class="section-head"><div><div class="eyebrow">Courses</div><h2>Your courses</h2></div><p>${courses.length ? `${courses.length} imported` : 'Nothing imported yet'}</p></section>
    ${courses.length ? `<div class="course-grid">${courses.map(course => { const summary = summariseCourse(course.progress || [], Date.now()); return `<a class="course" href="${courseLink(course)}"><div class="course-top"><span class="course-kicker">Course roster</span><span class="course-state">${studiedLabel(course.last_studied_at)}</span></div><h2>${esc(course.title)}</h2><dl class="course-metrics"><div><dt>People</dt><dd>${course.card_count}</dd></div><div><dt>Familiar</dt><dd>${summary.familiarPercent}%</dd></div><div><dt>Sessions</dt><dd>${course.session_count}</dd></div></dl><p class="course-cta">${course.last_studied_at ? 'Continue studying' : 'Start learning'} <span aria-hidden="true">→</span></p></a>`; }).join('')}</div>` : `<div class="empty"><h2>Your first course starts with a PDF.</h2><p>Source files remain on this machine. Imported information is saved in the local app database.</p></div>`}
    <section class="importer" style="margin-top:28px"><div class="eyebrow">New class</div><h2>Start a class from a roster</h2><p class="fine">The file is read on this machine and never uploaded — only the names and portraits are saved, and you approve everyone it finds before they appear in study sessions.</p><ol class="fine steps"><li>Open the course in <a href="https://flashcards.byu.edu" target="_blank" rel="noreferrer">BYU Flashcards</a>.</li><li>Choose <strong>Export</strong>, then <strong>3 students per page</strong>.</li><li>Download the PDF and pick it below.</li></ol><label class="new-class-name" for="new-class-title">Name this class <span class="fine">(optional — taken from the file name if you leave it blank)</span><input class="search" id="new-class-title" placeholder="e.g. ME EN 275, Winter" autocomplete="off"></label><div class="import-list"><label class="chip" for="new-class-file">Choose a roster PDF…<input id="new-class-file" type="file" accept="application/pdf,.pdf" hidden></label></div><div id="import-message"></div></section>
    <section class="importer" style="margin-top:28px"><div class="eyebrow">Local backup</div><h2>Download a portable backup</h2><p class="fine">A single zip holding every course, portrait, and review event. It is the restore path if your data is ever lost, and the only supported way to move your history to another device. ${store.kind === 'indexeddb'
      ? 'Everything is kept in this browser, on this device. Clearing site data removes it, and browsers can evict storage on their own after a period of not visiting — so a backup is the only thing that survives that.'
      : 'Your data lives in the local database under <code>app-data/</code>, which Git does not cover.'}</p><div class="import-list"><button class="chip" id="export-all">Export everything</button><button class="chip" id="export-rosters">Export rosters only (no progress)</button><label class="chip" for="restore-file">Restore a backup…<input id="restore-file" type="file" accept=".zip,application/zip" hidden></label></div><div id="restore-message"></div></section>`);
  document.querySelector('#load-demo')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const message = document.querySelector('#demo-message');
    button.disabled = true;
    button.textContent = 'Building the demo…';
    try {
      await store.importBundle(await demoBundle());
      await requestDurableStorage();
      home();
    } catch (error) {
      message.innerHTML = notice(error.message);
      button.disabled = false;
      button.textContent = 'Try it with a demo class';
    }
  });
  const exportEverything = async () => { await store.downloadExport(); recordBackup(); };
  document.querySelector('#export-all').addEventListener('click', exportEverything);
  document.querySelector('#reminder-export')?.addEventListener('click', async () => { await exportEverything(); home(); });
  document.querySelector('#warning-export')?.addEventListener('click', exportEverything);
  // A roster-only export is not a backup of anything, so it does not reset the reminder.
  document.querySelector('#export-rosters').addEventListener('click', () => store.downloadExport(undefined, {includeProgress: false}));
  const restoreInput = document.querySelector('#restore-file');
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    const message = document.querySelector('#restore-message');
    message.innerHTML = notice('Reading the backup…');
    try {
      const counts = await store.importBundle(file);
      await requestDurableStorage();
      message.innerHTML = notice(`Restored ${counts.courses} ${counts.courses === 1 ? 'course' : 'courses'}: ${counts.cards} people, ${counts.sessions} sessions, ${counts.reviews} recorded answers.`);
      setTimeout(home, 1400);
    } catch (error) {
      message.innerHTML = notice(error.message);
    } finally {
      restoreInput.value = '';
    }
  });

  const newClassInput = document.querySelector('#new-class-file');
  newClassInput.addEventListener('change', async () => {
    const file = newClassInput.files?.[0];
    if (!file) return;
    const message = document.querySelector('#import-message');
    const label = document.querySelector('[for="new-class-file"]');
    label.textContent = `Reading ${file.name}…`;
    message.innerHTML = notice('Reading the roster. Scanned PDFs need local OCR, which can take a minute.');
    try {
      const stopReporting = reportExtraction(message);
      try {
        var result = await store.createCourseFromRoster(file, document.querySelector('#new-class-title')?.value.trim() || undefined);
      } finally { stopReporting(); }
      message.innerHTML = notice(importSummary(result));
      location.hash = `#/course/${result.course_id}/review`;
    } catch (error) {
      message.innerHTML = notice(error.message);
      label.textContent = 'Choose a roster PDF…';
      newClassInput.value = '';
    }
  });
}

function learningPulse(stats) {
  const distribution = summariseCourse(stats.progress || [], Date.now()).distribution;
  const total = distribution.new + distribution.learning + distribution.familiar || 1;
  const segment = (name) => Math.round(distribution[name] / total * 100);
  const trend = stats.readiness_trend?.length ? readinessTrend(stats.readiness_trend) : '<p class="fine">Complete a session to begin your readiness trend.</p>';
  return `<section class="learning-pulse panel"><div class="pulse-heading"><div><div class="eyebrow">Learning pulse</div><h2>How the course is taking shape</h2></div><p class="fine">Click a person to see their learning snapshot.</p></div><div class="pulse-grid"><div><div class="pulse-label"><strong>Course familiarity</strong><span>${distribution.familiar} familiar · ${distribution.learning} learning · ${distribution.new} new</span></div><div class="distribution-bar" aria-label="${distribution.familiar} familiar, ${distribution.learning} learning, ${distribution.new} new"><span class="familiar" style="width:${segment('familiar')}%"></span><span class="learning" style="width:${segment('learning')}%"></span><span class="new" style="width:${segment('new')}%"></span></div><div class="distribution-key"><span><i class="familiar"></i>Familiar</span><span><i class="learning"></i>Learning</span><span><i class="new"></i>New</span></div><p class="distribution-summary"><strong>Familiar</strong><span>means they have been seen and reached at least 75% learning strength.</span></p></div><div class="trend"><div class="pulse-label"><strong>Average predicted recall</strong><span>Saved after each completed session.</span></div>${trend}</div></div></section>`;
}

function readinessTrend(sessions) {
  const width = 340;
  const height = 104;
  const top = 8;
  const bottom = 10;
  const left = 34;
  const right = 9;
  const x = (index) => sessions.length === 1 ? (left + width - right) / 2 : left + index * (width - left - right) / (sessions.length - 1);
  const y = (readiness) => top + (100 - readiness) * (height - top - bottom) / 100;
  const points = sessions.map((session, index) => `${x(index)},${y(session.readiness)}`).join(' ');
  const dots = sessions.map((session, index) => `<circle cx="${x(index)}" cy="${y(session.readiness)}" r="3"><title>${shortDate(session.ended_at)} · ${session.readiness}% average predicted recall</title></circle>`).join('');
  const guides = [100, 50, 0].map(value => `<text x="0" y="${y(value) + 3}">${value}%</text><line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"></line>`).join('');
  return `<div class="trend-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Average predicted recall across the last ${sessions.length} completed sessions">${guides}<polyline points="${points}"></polyline>${dots}</svg><div class="trend-foot"><span>${shortDate(sessions[0].ended_at)}</span><span>Last ${sessions.length} sessions</span><span>${shortDate(sessions[sessions.length - 1].ended_at)}</span></div></div>`;
}

async function courseView(courseId) {
  const [course, cards, candidates, stats] = await Promise.all([store.getCourse(courseId), store.listCards(courseId), store.listCandidates(courseId), store.getCourseStats(courseId)]);
  currentCourse = course;
  const summary = summariseCourse(stats.progress || [], Date.now());
  setView(`<a class="back" href="#/">← All courses</a><section class="section-head" style="margin-top:25px"><div><div class="eyebrow">${esc(course.source_filename)}</div><h1>${esc(course.title)}</h1><p>${cards.length} ${cards.length === 1 ? 'person' : 'people'}</p></div><div class="actions">${candidates.length ? `<button class="button secondary" id="review-candidates">Review ${candidates.length} new ${candidates.length === 1 ? 'name' : 'names'}</button>` : ''}<button class="button secondary" id="add-people">Add people</button><button class="button ghost" id="manage-course" aria-haspopup="dialog" title="Backup, remove someone, reset progress">Manage</button><button class="button" id="start-study">Start session</button></div></section><section class="stats" aria-label="Course statistics"><article class="stat panel"><strong>${summary.familiarPercent}%</strong><span>familiar</span></article><article class="stat panel"><strong>${summary.readiness}%</strong><span>avg. predicted recall</span></article><article class="stat panel"><strong>${stats.session_count}</strong><span>sessions</span></article><article class="stat panel"><strong>${stats.wrong_count} / ${stats.reviews}</strong><span>misses / answers</span></article></section>${learningPulse(stats)}<div class="toolbar"><input class="search" id="search" placeholder="Search people" aria-label="Search people"><select class="select" id="sort" aria-label="Sort roster"><option value="first">First name</option><option value="last">Last name</option><option value="recall">Predicted recall (low first)</option><option value="strength">Learning strength (low first)</option><option value="difficulty">Hardest to learn</option></select></div><div id="roster"></div>`);
  const roster = document.querySelector('#roster');
  const flippedCards = new Set();
  const histories = new Map();
  let visibleCards = cards;
  const cardMarkup = (card) => {
    const history = histories.get(card.id) || [];
    const flipped = flippedCards.has(card.id);
    const dots = history.length ? history.map(event => `<i class="answer-dot ${event.result}" title="${event.result === 'right' ? 'Correct' : 'Missed'} · ${shortDate(event.reviewed_at)}" aria-label="${event.result === 'right' ? 'Correct' : 'Missed'} on ${shortDate(event.reviewed_at)}"></i>`).join('') : '<span class="fine">No answers yet</span>';
    const historyRange = history.length ? `<small>${shortDate(history[0].reviewed_at)} → ${shortDate(history[history.length - 1].reviewed_at)}</small>` : '';
    return `<article class="person panel flip-card ${flipped ? 'is-flipped' : ''}" data-card-id="${card.id}" tabindex="0" role="button" aria-pressed="${flipped}" aria-label="${flipped ? 'Hide' : 'Show'} learning snapshot for ${esc(card.first_name)} ${esc(card.last_name)}"><div class="flip-card-inner"><div class="flip-face flip-front">${portrait(card)}<h2>${esc(card.first_name)} ${esc(card.last_name)}</h2><div class="fine">${card.seen_count ? `${card.right_count}/${card.seen_count} correct` : 'New to you'}</div>${recallMeter(card)}<p class="flip-hint">Click for learning snapshot</p></div><div class="flip-face flip-back"><div class="eyebrow">Learning snapshot</div><h2>${esc(card.first_name)} ${esc(card.last_name)}</h2><span class="status-tag status-${learningStatus(card).toLowerCase()}">${learningStatus(card)}</span><dl class="snapshot-stats"><div><dt>Learning strength</dt><dd>${Math.round(card.mastery * 100)}%</dd></div><div><dt>Last studied</dt><dd>${shortDate(card.last_reviewed_at)}</dd></div></dl><div class="answer-history"><span>Recent answers</span><div>${dots}</div>${historyRange}</div><p class="flip-hint">Click to return</p></div></div></article>`;
  };
  function renderRoster(items = visibleCards) {
    visibleCards = items;
    // An empty roster and an empty search result are different situations, and
    // telling somebody to import a roster when they have 69 people and a typo
    // in the search box is worse than saying nothing.
    const empty = cards.length
      ? `<div class="empty"><h2>Nobody matches that search.</h2><p>${cards.length} ${cards.length === 1 ? 'person is' : 'people are'} in this class. Clear the search to see everyone.</p></div>`
      : `<div class="empty"><h2>No approved people yet.</h2><p>Review the names the importer found, or add someone by hand.</p></div>`;
    roster.innerHTML = items.length ? `<div class="roster">${items.map(cardMarkup).join('')}</div>` : empty;
    roster.querySelectorAll('[data-card-id]').forEach(element => {
      const toggle = async () => {
        const cardId = element.dataset.cardId;
        if (flippedCards.has(cardId)) {
          flippedCards.delete(cardId);
          renderRoster();
          return;
        }
        if (!histories.has(cardId)) histories.set(cardId, await store.getCardHistory(courseId, cardId));
        flippedCards.add(cardId);
        renderRoster();
      };
      element.addEventListener('click', toggle);
      element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    });
  }
  renderRoster(cards);
  document.querySelector('#search').addEventListener('input', event => { const query = event.target.value.toLowerCase(); renderRoster(cards.filter(card => `${card.first_name} ${card.last_name}`.toLowerCase().includes(query))); });
  document.querySelector('#sort').addEventListener('change', event => {
    // Every ordering comes from the core, so "hardest" and "weakest" mean the
    // same thing here as they will in the browser build.
    cards.splice(0, cards.length, ...sortRoster(cards, event.target.value, Date.now()));
    renderRoster(cards.filter(card => `${card.first_name} ${card.last_name}`.toLowerCase().includes(document.querySelector('#search').value.toLowerCase())));
  });
  document.querySelector('#start-study').addEventListener('click', () => setupView(course, cards));
  document.querySelector('#add-people').addEventListener('click', () => addPeopleDialog(course, cards));
  document.querySelector('#manage-course').addEventListener('click', () => manageCourseDialog(course, cards, stats));
  document.querySelector('#review-candidates')?.addEventListener('click', () => { location.hash = `#/course/${course.id}/review`; });
}

function candidateView(course, candidates) {
  setView(`<a class="back" href="${courseLink(course)}">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Import review</div><h1>${candidates.length ? 'Approve people the importer found.' : 'No candidates waiting.'}</h1><p class="fine">Only approved entries appear in sessions. The importer stays cautious on purpose, so reject anyone it misread — rejecting only discards a candidate, never somebody you have been studying.</p>${candidates.length ? `<div class="roster">${candidates.map(card => `<article class="person panel">${portrait(card)}<h2>${esc(card.first_name)} ${esc(card.last_name)}</h2><div class="candidate-actions"><button class="button secondary" data-reject="${card.id}">Reject</button><button class="button" data-approve="${card.id}">Approve</button></div></article>`).join('')}</div>` : ''}</section>`);
  const refresh = async () => candidateView(course, await store.listCandidates(course.id));
  document.querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    await store.approveCandidate(course.id, button.dataset.approve);
    await refresh();
  }));
  document.querySelectorAll('[data-reject]').forEach(button => button.addEventListener('click', async () => {
    // One confirming click. A candidate has no study history to lose, so a
    // dialog here would be friction rather than safety.
    if (button.dataset.confirming !== 'yes') {
      document.querySelectorAll('[data-reject]').forEach(other => { other.dataset.confirming = 'no'; other.textContent = 'Reject'; });
      button.dataset.confirming = 'yes';
      button.textContent = 'Really reject?';
      return;
    }
    button.disabled = true;
    try {
      await store.rejectCandidate(course.id, button.dataset.reject);
      await refresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  }));
}

function manualCardView(course) {
  setView(`<a class="back" href="${courseLink(course)}">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Manual card</div><h1>Add a person.</h1><p class="fine">Use this for names the cautious PDF importer did not find, or to improve a course gradually.</p><form id="card-form" class="form"><div class="two"><input name="first" required placeholder="First name" aria-label="First name"><input name="last" required placeholder="Last name" aria-label="Last name"></div><textarea name="facts" rows="4" placeholder="Optional facts — one per line" aria-label="Optional facts"></textarea><div class="actions"><button class="button" type="submit">Save person</button></div><div id="form-notice"></div></form></section>`);
  document.querySelector('#card-form').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const facts = form.get('facts').split('\n').map(item => item.trim()).filter(Boolean); try { await store.addCard(course.id, {first_name: form.get('first'), last_name: form.get('last'), facts}); courseView(course.id); } catch(error) { document.querySelector('#form-notice').innerHTML = notice(error.message); } });
}

function setupView(course, courseCards) {
  const count = courseCards.length;
  let mode = 'all';
  let adaptiveLength = Math.min(15, count);
  let morrisLength = Math.min(7, count);
  setView(`<a class="back" href="${courseLink(course)}" id="setup-back">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Study setup</div><h1>What feels useful today?</h1><p class="fine">Every card is available whenever you are. Adaptive review simply makes a varied, helpful choice.</p><div class="mode-grid"><button class="mode selected" data-mode="all"><h2>All cards</h2><p>Every approved person once, in a fresh random order.</p></button><button class="mode" data-mode="continuous"><h2>Continuous</h2><p>Keeps going and keeps re-ranking. Miss someone and they return at widening gaps. Ends when you do.</p></button><button class="mode" data-mode="adaptive"><h2>Adaptive review</h2><p>A set length, weighted towards the people you are least likely to recall.</p></button><button class="mode" data-mode="morris"><h2>Expanding recall</h2><p>Repeats a focused base set inside one capped session with widening gaps.</p></button></div><label class="range hidden" id="base-size">Adaptive session length: <strong id="length-label">${adaptiveLength}</strong><input id="length" type="range" min="5" max="${Math.max(5, Math.min(50, count))}" value="${adaptiveLength}"></label><div class="actions"><button class="button" id="begin">Begin studying</button></div><div id="setup-notice"></div></section>`);
  document.querySelector('#setup-back').addEventListener('click', event => { event.preventDefault(); courseView(course.id); });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('selected', item === button)); document.querySelector('.range').classList.toggle('hidden', mode === 'all' || mode === 'continuous'); document.querySelector('#base-size').firstChild.textContent = mode === 'morris' ? 'Base people: ' : 'Adaptive session length: '; const input = document.querySelector('#length'); input.max = mode === 'morris' ? Math.max(5, Math.min(15, count)) : Math.max(5, Math.min(50, count)); input.value = mode === 'morris' ? Math.min(morrisLength, +input.max) : Math.min(adaptiveLength, +input.max); document.querySelector('#length-label').textContent = input.value; }));
  document.querySelector('#length').addEventListener('input', event => { const length = +event.target.value; if (mode === 'morris') morrisLength = length; else adaptiveLength = length; document.querySelector('#length-label').textContent = length; });
  document.querySelector('#begin').addEventListener('click', async () => {
    try {
      const limit = +document.querySelector('#length').value;
      const chosen = selectSessionCards(courseCards, mode, limit);
      const result = await store.startSession(course.id, mode, chosen.cards.map(card => card.id));
      initializeStudy({...result, ...chosen});
      await preloadPortrait(currentCard());
      studyView();
    } catch(error) {
      document.querySelector('#setup-notice').innerHTML = notice(error.message);
    }
  });
}

// Selection moved from the server to here, so the browser build can do it with
// no backend at all. `all` is every card once; expanding recall needs the rest
// of the roster as interleaved filler to hold its gaps open.
function selectSessionCards(courseCards, mode, limit) {
  const shuffle = (items) => items.map(item => [Math.random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  // Continuous re-ranks the whole roster as it goes, so it starts with all of it.
  if (mode === 'continuous') return {cards: [...courseCards], filler_cards: []};
  if (mode === 'all') return {cards: shuffle(courseCards), filler_cards: []};
  const cards = adaptiveCards(courseCards, limit);
  if (mode !== 'morris') return {cards, filler_cards: []};
  const chosen = new Set(cards.map(card => card.id));
  return {cards, filler_cards: shuffle(courseCards.filter(card => !chosen.has(card.id)))};
}

function initializeStudy(result) {
  study = {...result, index:0, revealed:false};
  if (study.mode === 'continuous') {
    // The core owns the ranking and the miss-recovery cycle; this just draws it.
    study.session = new ContinuousSession(result.cards);
    study.session.next();
    return;
  }
  if (study.mode === 'morris') {
    study = {...study, remaining:[...result.cards], pending:[], fillers:[...(result.filler_cards || [])], fillerIndex:0, current:null, currentIsFiller:false, stages:{}, reviews:0, maxReviews:Math.min(60, Math.max(20, result.cards.length * 7))};
    advanceMorris();
  }
}

function currentCard() {
  if (study?.mode === 'continuous') return study.session.current;
  return study?.mode === 'morris' ? study.current : study?.cards[study.index];
}

function advanceMorris() {
  const due = study.pending.findIndex(item => item.readyAt <= study.reviews);
  if (due >= 0) {
    study.current = study.pending.splice(due, 1)[0].card;
    study.currentIsFiller = false;
  } else if (study.remaining.length) {
    study.current = study.remaining.shift();
    study.currentIsFiller = false;
  } else if (study.pending.length && study.fillers.length) {
    study.current = study.fillers[study.fillerIndex % study.fillers.length];
    study.fillerIndex += 1;
    study.currentIsFiller = true;
  } else {
    study.current = null;
  }
}

function studyView() {
  const card = currentCard();
  if (!card) return completeStudy();
  const continuousStats = study.mode === 'continuous' ? study.session.stats : null;
  const complete = study.mode === 'continuous' ? null
    : study.mode === 'morris' ? Math.round((study.reviews / study.maxReviews) * 100)
    : Math.round((study.index / study.cards.length) * 100);
  const sessionTitle = study.mode === 'all' ? 'All cards'
    : study.mode === 'continuous' ? (study.session.currentIsRevisit ? 'Continuous · bringing this one back' : 'Continuous')
    : study.mode === 'morris' ? (study.currentIsFiller ? 'Expanding recall · interleaved review' : 'Expanding recall')
    : 'Adaptive review';
  const position = study.mode === 'continuous' ? `${continuousStats.reviews + 1} reviewed`
    : study.mode === 'morris' ? `${study.reviews + 1} / up to ${study.maxReviews}`
    : `${study.index + 1} / ${study.cards.length}`;
  const morrisProgress = study.mode === 'morris' ? expandingProgress(card)
    : study.mode === 'continuous' ? continuousProgress(continuousStats)
    : '';
  setView(`<div class="study-wrap"><div class="session-meta"><span>${sessionTitle}</span><span>${position}</span></div>${morrisProgress}<div class="study-card" id="flashcard" role="button" tabindex="0" aria-label="Flip card">${portrait(card)}<div class="study-copy">${study.revealed ? `<div class="answer"><div class="eyebrow">The answer</div><div class="name">${esc(card.first_name)} ${esc(card.last_name)}</div>${card.facts.length ? `<ul>${card.facts.map(fact=>`<li>${esc(fact)}</li>`).join('')}</ul>` : ''}</div>` : `<div><div class="eyebrow">Your turn</div><h1>Name this student.</h1><p>Flip when you have an answer in mind.</p></div>`}</div></div><div class="study-actions">${study.revealed ? `<button class="button danger" id="wrong">Wrong <span class="key">W</span></button><button class="button" id="right">Right <span class="key">R</span></button>` : `<button class="button secondary" id="flip">Flip card <span class="key">Space</span></button><button class="button" id="right">Right <span class="key">R</span></button>`}</div><div class="fine" style="margin-top:18px">${complete === null ? 'No set length' : `${complete}% complete`} · <span class="key">Esc</span> to end session · <button class="link-button" id="show-help" aria-haspopup="dialog">Shortcuts <span class="key">?</span></button></div></div>`);
  const reveal = () => { if (!study.revealed) { study.revealed = true; studyView(); } };
  document.querySelector('#show-help').addEventListener('click', openHelp);
  document.querySelector('#flashcard').addEventListener('click', reveal); document.querySelector('#flashcard').addEventListener('keydown', event => { if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reveal(); } });
  document.querySelector('#flip')?.addEventListener('click', reveal);
  document.querySelector('#right')?.addEventListener('click', () => score('right'));
  document.querySelector('#wrong')?.addEventListener('click', () => score('wrong'));
}

/**
 * Both ways of adding people, in one place.
 *
 * Importing a roster used to live at the bottom of the page under "Course
 * data", which is not where anyone looks for it — adding people is adding
 * people, whether they arrive by the dozen from a PDF or one at a time by hand.
 * The export instructions are here too, because the moment somebody wants to
 * add people is the moment they need to know how to get the file.
 */
function addPeopleDialog(course, cards) {
  showDialog(
    `${dialogHead('Add people')}
    <div class="add-route">
      <h3>From a roster</h3>
      <p class="fine">Best for a whole class, or for people who joined late — anyone already here keeps their study history, and only new names need approving.</p>
      <ol class="fine steps"><li>Open the course in <a href="https://flashcards.byu.edu" target="_blank" rel="noreferrer">BYU Flashcards</a>.</li><li>Choose <strong>Export</strong>, then <strong>3 students per page</strong>.</li><li>Download the PDF and pick it below.</li></ol>
      <label class="chip" for="dialog-roster-file">Choose a roster PDF…<input id="dialog-roster-file" type="file" accept="application/pdf,.pdf" hidden></label>
      <div id="dialog-import-message"></div>
    </div>
    <div class="add-route">
      <h3>One at a time</h3>
      <p class="fine">For somebody the importer missed. They are added straight away — you typed the name, so there is nothing to review.</p>
      <form id="dialog-card-form" class="stacked">
        <label for="d-first">First name</label><input class="search" id="d-first" name="first" required autocomplete="off">
        <label for="d-last">Last name</label><input class="search" id="d-last" name="last" required autocomplete="off">
        <label for="d-photo">Photo <span class="fine">(optional)</span></label><input class="search" id="d-photo" type="file" accept="image/*">
        <label for="d-facts">Notes, one per line <span class="fine">(optional — shown when you flip the card)</span></label><textarea class="search" id="d-facts" name="facts" rows="2"></textarea>
        <div class="modal-actions"><button class="button" type="submit">Add person</button></div>
      </form>
      <div id="dialog-form-notice"></div>
    </div>`,
    (backdrop) => {
      const rosterInput = backdrop.querySelector('#dialog-roster-file');
      rosterInput.addEventListener('change', async () => {
        const file = rosterInput.files?.[0];
        if (!file) return;
        const message = backdrop.querySelector('#dialog-import-message');
        const stopReporting = reportExtraction(message);
        backdrop.querySelector('[for="dialog-roster-file"]').textContent = `Reading ${file.name}…`;
        message.innerHTML = notice('Reading the roster. A scanned class can take a moment.');
        try {
          const result = await store.importRosterIntoCourse(course.id, file);
          closeDialog();
          if (result.added) location.hash = `#/course/${course.id}/review`;
          else courseView(course.id);
        } catch (error) {
          message.innerHTML = notice(error.message);
          backdrop.querySelector('[for="dialog-roster-file"]').textContent = 'Choose a roster PDF…';
          rosterInput.value = '';
        } finally {
          stopReporting();
        }
      });

      backdrop.querySelector('#dialog-card-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const notice_ = backdrop.querySelector('#dialog-form-notice');
        const facts = backdrop.querySelector('#d-facts').value.split('\n').map(line => line.trim()).filter(Boolean);
        try {
          await store.addCard(
            course.id,
            {first_name: backdrop.querySelector('#d-first').value, last_name: backdrop.querySelector('#d-last').value, facts},
            backdrop.querySelector('#d-photo').files?.[0] ?? null,
          );
          closeDialog();
          courseView(course.id);
        } catch (error) {
          notice_.innerHTML = notice(error.message);
        }
      });
    },
  );
}

/** Backup and clean-up, out of the way but not buried at the foot of the page. */
function manageCourseDialog(course, cards, stats) {
  showDialog(
    `${dialogHead('Manage this class')}
    <p class="fine">${cards.length} ${cards.length === 1 ? 'person' : 'people'} · ${stats.reviews || 0} recorded ${stats.reviews === 1 ? 'answer' : 'answers'} across ${stats.session_count || 0} ${stats.session_count === 1 ? 'session' : 'sessions'}.</p>
    <div class="import-list" style="margin-top:16px">
      <button class="chip" id="m-export">Export a backup</button>
      <button class="chip" id="m-remove">Remove someone who left</button>
      <button class="chip" id="m-reset">Reset all progress</button>
      <button class="chip danger-chip" id="m-delete">Delete this class</button>
    </div>`,
    (backdrop) => {
      backdrop.querySelector('#m-export').addEventListener('click', async () => { await store.downloadExport(course.id); recordBackup(); });
      backdrop.querySelector('#m-remove').addEventListener('click', () => removePersonDialog(course, cards));
      backdrop.querySelector('#m-reset').addEventListener('click', () => resetProgressDialog(course, stats));
      backdrop.querySelector('#m-delete').addEventListener('click', () => deleteCourseDialog(course, cards, stats));
    },
  );
}

function removePersonDialog(course, cards) {
  const row = (card) => `<div class="remove-row" data-remove="${card.id}">${portrait(card)}<span>${esc(card.first_name)} ${esc(card.last_name)}<br><small>${card.seen_count ? `${card.right_count}/${card.seen_count} correct` : 'Never studied'}</small></span><button class="button secondary" data-remove-button="${card.id}">Remove</button></div>`;
  showDialog(
    `${dialogHead('Remove someone who left')}<p class="fine">Removing a person deletes their photo and their review history along with them. Everyone else is untouched.</p><label for="remove-search">Find a person</label><input class="search" id="remove-search" autofocus placeholder="Search by name" aria-label="Search people to remove"><div class="remove-list" id="remove-list">${cards.map(row).join('')}</div>`,
    (backdrop) => {
      const list = backdrop.querySelector('#remove-list');
      backdrop.querySelector('#remove-search').addEventListener('input', event => {
        const term = event.target.value.toLowerCase();
        list.innerHTML = cards.filter(card => `${card.first_name} ${card.last_name}`.toLowerCase().includes(term)).map(row).join('');
      });
      list.addEventListener('click', async event => {
        const button = event.target.closest('[data-remove-button]');
        if (!button) return;
        const card = cards.find(item => item.id === button.dataset.removeButton);
        // Confirming in place rather than in a second dialog: the row already
        // names the person, so a two-step click is enough to prevent a slip.
        if (button.dataset.confirming !== 'yes') {
          list.querySelectorAll('[data-confirming]').forEach(other => { other.dataset.confirming = 'no'; other.textContent = 'Remove'; });
          button.dataset.confirming = 'yes';
          button.textContent = 'Really remove?';
          return;
        }
        button.disabled = true;
        button.textContent = 'Removing…';
        try {
          await store.removeCard(course.id, card.id);
          closeDialog();
          courseView(course.id);
        } catch (error) {
          button.disabled = false;
          button.textContent = error.message;
        }
      });
    },
  );
}

/**
 * Remove a class outright.
 *
 * Guarded exactly as resetting is, because it destroys the same irreplaceable
 * thing and more of it. The difference is worth stating on screen: a reset
 * keeps the people and forgets how well you know them, while this keeps
 * nothing.
 */
function deleteCourseDialog(course, cards, stats) {
  const reviews = stats.reviews || 0;
  showDialog(
    `${dialogHead('Delete this class')}<div class="danger-note"><strong>This cannot be undone.</strong> It removes ${cards.length} ${cards.length === 1 ? 'person' : 'people'}, their photos, and ${reviews} recorded ${reviews === 1 ? 'answer' : 'answers'} across ${stats.session_count || 0} ${stats.session_count === 1 ? 'session' : 'sessions'}. Resetting progress instead would keep the people and only forget how well you know them.</div><p class="fine">Review history cannot be reconstructed from anything else. <button class="link-button" id="delete-export">Export a backup first</button>.</p><label for="delete-confirm">Type <strong>${esc(course.title)}</strong> to confirm</label><input class="search" id="delete-confirm" autofocus autocomplete="off" aria-label="Type the class name to confirm"><div id="delete-notice"></div><div class="modal-actions"><button class="button secondary" data-close>Cancel</button><button class="button danger" id="delete-confirm-button" disabled>Delete class</button></div>`,
    (backdrop) => {
      backdrop.querySelector('#delete-export').addEventListener('click', async () => { await store.downloadExport(course.id); recordBackup(); });
      const input = backdrop.querySelector('#delete-confirm');
      const confirm = backdrop.querySelector('#delete-confirm-button');
      input.addEventListener('input', () => { confirm.disabled = input.value.trim() !== course.title; });
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        confirm.textContent = 'Deleting…';
        try {
          await store.deleteCourse(course.id, input.value);
          closeDialog();
          location.hash = '#/';
          home();
        } catch (error) {
          backdrop.querySelector('#delete-notice').innerHTML = notice(error.message);
          confirm.disabled = false;
          confirm.textContent = 'Delete class';
        }
      });
    },
  );
}

function resetProgressDialog(course, stats) {
  const sessions = stats.session_count || 0;
  const reviews = stats.reviews || 0;
  showDialog(
    `${dialogHead('Reset all progress')}<div class="danger-note"><strong>This cannot be undone.</strong> It discards ${reviews} recorded ${reviews === 1 ? 'answer' : 'answers'} across ${sessions} ${sessions === 1 ? 'session' : 'sessions'}, and returns everyone in this course to never-studied. The people themselves stay.</div><p class="fine">Timestamped review history cannot be reconstructed from anything else. <button class="link-button" id="reset-export">Export a backup first</button>.</p><label for="reset-confirm">Type <strong>${esc(course.title)}</strong> to confirm</label><input class="search" id="reset-confirm" autofocus autocomplete="off" aria-label="Type the course title to confirm"><div id="reset-notice"></div><div class="modal-actions"><button class="button secondary" data-close>Cancel</button><button class="button danger" id="reset-confirm-button" disabled>Reset progress</button></div>`,
    (backdrop) => {
      backdrop.querySelector('#reset-export').addEventListener('click', () => store.downloadExport(course.id));
      const input = backdrop.querySelector('#reset-confirm');
      const confirm = backdrop.querySelector('#reset-confirm-button');
      input.addEventListener('input', () => { confirm.disabled = input.value.trim() !== course.title; });
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        confirm.textContent = 'Resetting…';
        try {
          await store.resetCourseProgress(course.id, input.value);
          closeDialog();
          courseView(course.id);
        } catch (error) {
          backdrop.querySelector('#reset-notice').innerHTML = notice(error.message);
          confirm.disabled = false;
          confirm.textContent = 'Reset progress';
        }
      });
    },
  );
}

const SHORTCUTS = [
  {keys: ['Space', 'Enter'], action: 'Flip the card over'},
  {keys: ['R'], action: 'Mark right — works before flipping, for a name you already know'},
  {keys: ['W'], action: 'Mark wrong — available once the card is flipped'},
  {keys: ['Esc'], action: 'End the session and see the summary'},
  {keys: ['?'], action: 'Show and hide this list'},
];

function shortcutHelp() {
  const rows = SHORTCUTS.map(({keys, action}) =>
    `<div class="shortcut-row"><dt>${keys.map(key => `<span class="key">${esc(key)}</span>`).join('<span class="shortcut-or">or</span>')}</dt><dd>${esc(action)}</dd></div>`).join('');
  return `${dialogHead('Keyboard shortcuts')}<dl class="shortcut-list">${rows}</dl><p class="fine">Shortcuts are ignored while you are typing in a search or text field.</p>`;
}

// A dialog that owns focus while it is open and hands it back on close. The
// shortcut list, the remove-a-person list and the reset confirmation all use it.
let openDialog = null;

function showDialog(html, wire, kind = 'dialog') {
  closeDialog();
  const returnFocusTo = document.activeElement;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal-backdrop"><div class="modal-panel panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</div></div>`);
  const backdrop = document.querySelector('#modal-backdrop');
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeDialog(); });
  backdrop.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeDialog));
  openDialog = {backdrop, returnFocusTo, kind};
  wire?.(backdrop);
  (backdrop.querySelector('[autofocus]') || backdrop.querySelector('[data-close]'))?.focus();
}

function closeDialog() {
  if (!openDialog) return;
  const {backdrop, returnFocusTo} = openDialog;
  openDialog = null;
  backdrop.remove();
  returnFocusTo?.focus?.();
}

function dialogHead(title) {
  return `<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="button secondary" data-close aria-label="Close">Close <span class="key">Esc</span></button></div>`;
}

function openHelp() {
  if (openDialog || !study) return;
  showDialog(shortcutHelp(), null, 'help');
}

function continuousProgress(stats) {
  const working = stats.queued
    ? `<strong>${stats.queued}</strong> ${stats.queued === 1 ? 'person is' : 'people are'} being brought back`
    : '<strong>Nobody</strong> is waiting to come back';
  const recovered = stats.recovered ? ` · ${stats.recovered} recovered after a miss` : '';
  return `<section class="morris-progress" aria-label="Continuous session progress"><div>${working}${recovered}</div><p>Miss someone and they return after a short gap, then at widening gaps until you have named them three times running.</p></section>`;
}

function expandingProgress(card) {
  const totalSteps = study.cards.length * 3;
  const earnedSteps = study.cards.reduce((total, item) => total + Math.min(3, study.stages[item.id] || 0), 0);
  const mastered = study.cards.filter(item => (study.stages[item.id] || 0) >= 3).length;
  const currentStage = study.stages[card.id] || 0;
  const focus = study.currentIsFiller
    ? 'Interleaved review gives your selected people time between recalls.'
    : currentStage === 2
      ? 'One more successful recall will master this student for this session.'
      : `This student is on recall ${currentStage + 1} of 3.`;
  return `<section class="morris-progress" aria-label="Expanding recall progress"><div><strong>${mastered} of ${study.cards.length} mastered</strong></div><div class="progress-track" role="progressbar" aria-label="Selected-card mastery progress" aria-valuemin="0" aria-valuemax="${totalSteps}" aria-valuenow="${earnedSteps}"><span style="width:${totalSteps ? Math.round(earnedSteps / totalSteps * 100) : 0}%"></span></div><p>${focus}</p></section>`;
}

async function score(result) {
  if (scoring || !study) return;
  scoring = true;
  const card = currentCard();
  try {
    // The core owns the memory model; the server stores what it produces. The
    // instant is computed once and sent along, so the stored timestamp is the
    // one the computation actually used.
    const reviewedAt = new Date().toISOString();
    // In continuous mode the core's session applies the update itself, because
    // its ranking and its miss-recovery queue both depend on the new state.
    const memory = study.mode === 'continuous'
      ? study.session.record(result, reviewedAt).memory
      : updateMemoryState(card, result, reviewedAt);
    await store.recordReview(study.id, {card_id: card.id, result, mastery: memory.mastery, stability_days: memory.stability_days, reviewed_at: reviewedAt});
    if (study.mode === 'continuous') {
      study.session.next();
    } else {
      // Keep the in-memory card in step, so a repeat within this session scores
      // against its updated state rather than the state it started with.
      Object.assign(card, memory, {last_reviewed_at: reviewedAt, seen_count: (card.seen_count || 0) + 1});
    }
    if (study.mode === 'continuous') {
      // No end condition: the session runs until the learner stops it.
    } else if (study.mode === 'morris') {
      study.reviews += 1;
      if (!study.currentIsFiller) {
        const stage = result === 'right' ? (study.stages[card.id] || 0) + 1 : 0;
        study.stages[card.id] = stage;
        if (result === 'wrong' || stage < 3) study.pending.push({card, readyAt:study.reviews + (result === 'wrong' ? 2 : stage === 1 ? 3 : 7)});
      }
      if (study.reviews >= study.maxReviews) return completeStudy();
      advanceMorris();
    } else {
      study.index += 1;
    }
    if (!currentCard()) return completeStudy();
    study.revealed = false;
    await preloadPortrait(currentCard());
    studyView();
  } finally {
    scoring = false;
  }
}

async function completeStudy() {
  if (!study) return;
  closeDialog();
  const finishedStudy = study;
  // Re-read the roster so readiness is computed from what was actually stored,
  // rather than from whatever this session happened to touch.
  const readiness = currentCourse
    ? courseReadiness(await store.listCards(currentCourse.id), Date.now())
    : null;
  const result = await store.completeSession(finishedStudy.id, readiness);
  const accuracy = result.reviewed_count ? Math.round(result.right_count / result.reviewed_count * 100) : 0;
  const restart = finishedStudy.mode === 'all' || finishedStudy.mode === 'continuous' ? '' : `<button class="button secondary" id="restart-same">Study these ${finishedStudy.cards.length} people again</button>`;
  // Expanding recall shows a person several times and interleaves other cards,
  // so attempts and people are different numbers and are reported separately.
  const people = result.people_count ?? result.reviewed_count;
  const tally = result.reviewed_count === people
    ? `You reviewed ${people} ${people === 1 ? 'person' : 'people'}`
    : `You made ${result.reviewed_count} attempts across ${people} ${people === 1 ? 'person' : 'people'}`;
  setView(`<section class="setup"><div class="eyebrow">Session complete</div><h1>${accuracy}% correct.</h1><p class="fine">${tally}: ${result.right_count} right and ${result.wrong_count} wrong. Your next adaptive session will adjust from what you just learned.</p><div class="actions">${restart}<a class="button" id="complete-back" href="${courseLink(currentCourse)}">Back to course</a></div></section>`);
  study = null;
  document.querySelector('#complete-back').addEventListener('click', event => { event.preventDefault(); courseView(currentCourse.id); });
  document.querySelector('#restart-same')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      const result = await store.startSession(currentCourse.id, finishedStudy.mode, finishedStudy.cards.map(card => card.id));
      initializeStudy({...result, cards:[...finishedStudy.cards], filler_cards:[...(finishedStudy.fillers || [])]});
      await preloadPortrait(currentCard());
      studyView();
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  });
}

document.addEventListener('keydown', event => {
  // An open dialog owns the keyboard, whatever it is: Escape closes it rather
  // than ending the session, '?' shuts the shortcut list, and scoring keys are
  // inert so a stray R cannot mark a card while somebody is reading a dialog.
  // Keyed off the dialog itself rather than a separate flag — when those two
  // could disagree, closing by any route except Escape left every shortcut dead.
  if (openDialog) {
    if (event.key === 'Escape' || (event.key === '?' && openDialog.kind === 'help')) {
      event.preventDefault();
      closeDialog();
    }
    return;
  }
  if (!study || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (event.key === '?') { event.preventDefault(); openHelp(); return; }
  if (scoring) return;
  if ((event.key === ' ' || event.key === 'Enter') && !study.revealed) { event.preventDefault(); study.revealed = true; studyView(); }
  if (event.key.toLowerCase() === 'r') score('right');
  if (study.revealed && event.key.toLowerCase() === 'w') score('wrong');
  if (event.key === 'Escape') completeStudy();
});
/**
 * Show a failure rather than leaving the loading state on screen.
 *
 * Every view begins by replacing the page with a spinner, so anything that
 * throws on the way to rendering leaves that spinner up for good: the app looks
 * like it is still working when it has already given up. This is the difference
 * between a server that stopped answering and a hang, and the learner should be
 * able to tell them apart and retry.
 */
function showFailure(error) {
  setView(`<section class="empty"><h2>Something went wrong.</h2><p>${esc(error?.message || 'The app could not load your data.')}</p><div class="actions" style="justify-content:center"><button class="button" id="retry">Try again</button><a class="button secondary" href="#/">Back to courses</a></div></section>`);
  document.querySelector('#retry')?.addEventListener('click', () => route());
}

window.addEventListener('hashchange', route);
async function route() {
  try {
    const match = location.hash.match(/^#\/course\/([^/]+)(?:\/(review|add))?$/);
    if (!match) return await home();
    const [, courseId, child] = match;
    if (!child) return await courseView(courseId);
    const course = await store.getCourse(courseId);
    if (child === 'review') return candidateView(course, await store.listCandidates(courseId));
    return manualCardView(course);
  } catch (error) {
    showFailure(error);
  }
}
route();

// Offline support, and only for the hosted build: the local build is already
// served from this machine, and a cache in front of it would just mean editing
// a file and being served the previous one.
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url)).then(registration => {
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        // Only prompt when there was already a version here; the first install
        // is not an update and saying so would be confusing.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          const bar = document.createElement('div');
          bar.className = 'notice update-ready';
          bar.setAttribute('role', 'status');
          bar.innerHTML = 'A new version of Familiar is ready. <button class="link-button" id="apply-update">Reload to use it</button>';
          document.querySelector('.shell')?.prepend(bar);
          document.querySelector('#apply-update')?.addEventListener('click', () => {
            installing.postMessage('activate-update');
            location.reload();
          });
        }
      });
    });
  }).catch((error) => {
    // Offline support is a bonus and the app works without it, but swallowing
    // this entirely would hide a real failure behind a feature that silently
    // never worked.
    console.warn('Offline support is unavailable:', error);
  });
}
