const app = document.querySelector('#app');
let currentCourse = null;
let study = null;
let scoring = false;

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json()).detail || 'Something went wrong.');
  return response.json();
}
const esc = (value) => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const initials = (card) => `${card.first_name[0] || ''}${card.last_name[0] || ''}`.toUpperCase();
const courseLink = (course) => `#/course/${course.id}`;
const portraitUrl = (card) => `/assets/${encodeURI(card.image_path)}`;
const portrait = (card) => card.image_path ? `<img class="avatar portrait" src="${portraitUrl(card)}" alt="Portrait of ${esc(card.first_name)} ${esc(card.last_name)}">` : `<div class="avatar">${initials(card)}</div>`;
const studiedLabel = (timestamp) => timestamp ? `Last studied ${new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', year:'numeric'}).format(new Date(timestamp))}` : 'Ready to learn';
const shortDate = (timestamp) => timestamp ? new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric'}).format(new Date(timestamp)) : 'Not yet';
const learningStatus = (card) => !card.seen_count ? 'New' : card.mastery >= .75 ? 'Familiar' : 'Learning';
const predictedRecall = (card) => {
  const daysSinceReview = card.last_reviewed_at ? Math.max(0, (Date.now() - new Date(card.last_reviewed_at).getTime()) / 86_400_000) : 365;
  const estimate = Number(card.mastery) * Math.exp(-daysSinceReview / Math.max(Number(card.stability_days), .02));
  return Math.max(.01, Math.min(.99, estimate));
};

function recallMeter(card) {
  if (!card.seen_count) return `<div class="recall-meter is-new"><div><span>Predicted recall</span><strong>New</strong></div><div class="recall-track"><i></i></div></div>`;
  const recall = Math.round(predictedRecall(card) * 100);
  const tone = recall >= 75 ? 'strong' : recall >= 40 ? 'building' : 'weak';
  return `<div class="recall-meter ${tone}"><div><span>Predicted recall today</span><strong>${recall}%</strong></div><div class="recall-track" role="progressbar" aria-label="Predicted recall today" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${recall}"><i style="width:${recall}%"></i></div></div>`;
}

async function preloadPortrait(card) {
  if (!card?.image_path) return;
  const image = new Image();
  image.src = portraitUrl(card);
  if (image.decode) await image.decode().catch(() => {});
  else await new Promise(resolve => { image.onload = image.onerror = resolve; });
}

function setView(html) { app.innerHTML = html; }
function notice(message) { return `<p class="notice">${esc(message)}</p>`; }

async function home() {
  setView(document.querySelector('#loading').innerHTML);
  const [courses, pdfs] = await Promise.all([api('/courses'), api('/imports/available')]);
  setView(`
    <section class="hero"><div class="eyebrow">For BYU instructors</div><h1>Know every student<br>before the first day.</h1><p>Import a BYU Flashcards roster, confirm the people it finds, and build familiarity in short, adaptive sessions.</p></section>
    <section class="section-head"><div><div class="eyebrow">Courses</div><h1>Your courses</h1></div><p>${courses.length ? `${courses.length} imported` : 'Nothing imported yet'}</p></section>
    ${courses.length ? `<div class="course-grid">${courses.map(course => `<a class="course" href="${courseLink(course)}"><div class="course-top"><span class="course-kicker">Course roster</span><span class="course-state">${studiedLabel(course.last_studied_at)}</span></div><h2>${esc(course.title)}</h2><dl class="course-metrics"><div><dt>People</dt><dd>${course.card_count}</dd></div><div><dt>Familiar</dt><dd>${course.familiar_percent}%</dd></div><div><dt>Sessions</dt><dd>${course.session_count}</dd></div></dl><p class="course-cta">${course.last_studied_at ? 'Continue studying' : 'Start learning'} <span aria-hidden="true">→</span></p></a>`).join('')}</div>` : `<div class="empty"><h2>Your first course starts with a PDF.</h2><p>Source files remain on this machine. Imported information is saved in the local app database.</p></div>`}
    <section class="importer" style="margin-top:28px"><div class="eyebrow">Local import</div><h2>Import from <code>data/</code></h2><p class="fine">The importer extracts only high-confidence name lines first. You approve its candidates before they are included in study sessions.</p><div class="import-list">${pdfs.length ? pdfs.map(pdf => `<button class="chip" data-import="${esc(pdf.filename)}">Import ${esc(pdf.filename)}</button>`).join('') : '<span class="fine">No PDFs found in the mounted data directory.</span>'}</div><div id="import-message"></div></section>
    <section class="importer" style="margin-top:28px"><div class="eyebrow">Local backup</div><h2>Download a portable backup</h2><p class="fine">A single zip holding every course, portrait, and review event. It is the restore path if this database is ever lost, and the only supported way to move your history somewhere else. <code>app-data/</code> is not covered by Git.</p><div class="import-list"><a class="chip" href="/api/export" download>Export everything</a><a class="chip" href="/api/export?include_progress=false" download>Export rosters only (no progress)</a></div></section>`);
  document.querySelectorAll('[data-import]').forEach(button => button.addEventListener('click', async () => {
    const message = document.querySelector('#import-message'); button.disabled = true; button.textContent = 'Importing…';
    try { const result = await api('/imports', {method:'POST', body:JSON.stringify({filename:button.dataset.import})}); message.innerHTML = notice(result.status === 'already_imported' ? 'That exact PDF was already imported.' : `Imported ${result.cards} candidate cards from ${result.pages} pages. Review the candidates next.`); if (result.warning) message.innerHTML += notice(result.warning); setTimeout(home, 1100); } catch (error) { message.innerHTML = notice(error.message); button.disabled = false; button.textContent = `Import ${button.dataset.import}`; }
  }));
}

function learningPulse(stats) {
  const distribution = stats.distribution || {new: 0, learning: 0, familiar: 0};
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
  const [course, cards, candidates, stats] = await Promise.all([api(`/courses/${courseId}`), api(`/courses/${courseId}/cards?sort=first`), api(`/courses/${courseId}/candidates`), api(`/courses/${courseId}/stats`)]);
  currentCourse = course;
  setView(`<a class="back" href="#/">← All courses</a><section class="section-head" style="margin-top:25px"><div><div class="eyebrow">${esc(course.source_filename)}</div><h1>${esc(course.title)}</h1><p>${cards.length} approved cards · ${candidates.length} waiting for review</p></div><div class="actions"><a class="button secondary" id="export-course" href="/api/courses/${encodeURIComponent(course.id)}/export" download>Export course</a><button class="button secondary" id="review-candidates">Review imports</button><button class="button secondary" id="add-card">Add person</button><button class="button" id="start-study">Start session</button></div></section><section class="stats" aria-label="Course statistics"><article class="stat panel"><strong>${stats.familiar_percent}%</strong><span>familiar</span></article><article class="stat panel"><strong>${stats.readiness}%</strong><span>avg. predicted recall</span></article><article class="stat panel"><strong>${stats.session_count}</strong><span>sessions</span></article><article class="stat panel"><strong>${stats.wrong_count} / ${stats.reviews}</strong><span>misses / answers</span></article></section>${learningPulse(stats)}<div class="toolbar"><input class="search" id="search" placeholder="Search people" aria-label="Search people"><select class="select" id="sort" aria-label="Sort roster"><option value="first">First name</option><option value="last">Last name</option><option value="confidence">Predicted recall (low first)</option></select></div><div id="roster"></div>`);
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
    roster.innerHTML = items.length ? `<div class="roster">${items.map(cardMarkup).join('')}</div>` : `<div class="empty"><h2>No approved cards yet.</h2><p>Review the imported candidates, or add cards after your first successful PDF import.</p></div>`;
    roster.querySelectorAll('[data-card-id]').forEach(element => {
      const toggle = async () => {
        const cardId = element.dataset.cardId;
        if (flippedCards.has(cardId)) {
          flippedCards.delete(cardId);
          renderRoster();
          return;
        }
        if (!histories.has(cardId)) histories.set(cardId, (await api(`/courses/${courseId}/cards/${cardId}/history`)).events);
        flippedCards.add(cardId);
        renderRoster();
      };
      element.addEventListener('click', toggle);
      element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    });
  }
  renderRoster(cards);
  document.querySelector('#search').addEventListener('input', event => { const query = event.target.value.toLowerCase(); renderRoster(cards.filter(card => `${card.first_name} ${card.last_name}`.toLowerCase().includes(query))); });
  document.querySelector('#sort').addEventListener('change', async event => { const sorted = await api(`/courses/${courseId}/cards?sort=${event.target.value}`); cards.splice(0, cards.length, ...sorted); renderRoster(cards.filter(card => `${card.first_name} ${card.last_name}`.toLowerCase().includes(document.querySelector('#search').value.toLowerCase()))); });
  document.querySelector('#start-study').addEventListener('click', () => setupView(course, cards.length));
  document.querySelector('#review-candidates').addEventListener('click', () => { location.hash = `#/course/${course.id}/review`; });
  document.querySelector('#add-card').addEventListener('click', () => { location.hash = `#/course/${course.id}/add`; });
}

function candidateView(course, candidates) {
  setView(`<a class="back" href="${courseLink(course)}">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Import review</div><h1>${candidates.length ? 'Approve people the importer found.' : 'No candidates waiting.'}</h1><p class="fine">Only approved entries appear in sessions. The initial parser intentionally stays cautious.</p>${candidates.length ? `<div class="roster">${candidates.map(card => `<article class="person panel">${portrait(card)}<h2>${esc(card.first_name)} ${esc(card.last_name)}</h2><button class="button secondary" data-approve="${card.id}">Approve</button></article>`).join('')}</div>` : ''}</section>`);
  document.querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; await api(`/courses/${course.id}/candidates/${button.dataset.approve}/approve`, {method:'POST'}); candidateView(course, await api(`/courses/${course.id}/candidates`)); }));
}

function manualCardView(course) {
  setView(`<a class="back" href="${courseLink(course)}">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Manual card</div><h1>Add a person.</h1><p class="fine">Use this for names the cautious PDF importer did not find, or to improve a course gradually.</p><form id="card-form" class="form"><div class="two"><input name="first" required placeholder="First name" aria-label="First name"><input name="last" required placeholder="Last name" aria-label="Last name"></div><textarea name="facts" rows="4" placeholder="Optional facts — one per line" aria-label="Optional facts"></textarea><div class="actions"><button class="button" type="submit">Save person</button></div><div id="form-notice"></div></form></section>`);
  document.querySelector('#card-form').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const facts = form.get('facts').split('\n').map(item => item.trim()).filter(Boolean); try { await api(`/courses/${course.id}/cards`, {method:'POST', body:JSON.stringify({first_name:form.get('first'),last_name:form.get('last'),facts})}); courseView(course.id); } catch(error) { document.querySelector('#form-notice').innerHTML = notice(error.message); } });
}

function setupView(course, count) {
  let mode = 'adaptive';
  let adaptiveLength = Math.min(15, count);
  let morrisLength = Math.min(7, count);
  setView(`<a class="back" href="${courseLink(course)}" id="setup-back">← ${esc(course.title)}</a><section class="setup"><div class="eyebrow">Study setup</div><h1>What feels useful today?</h1><p class="fine">Every card is available whenever you are. Adaptive review simply makes a varied, helpful choice.</p><div class="mode-grid"><button class="mode selected" data-mode="adaptive"><h2>Adaptive review</h2><p>Prioritizes people with the lowest predicted recall.</p></button><button class="mode" data-mode="morris"><h2>Expanding recall</h2><p>Repeats a focused base set inside one capped session with widening gaps.</p></button><button class="mode" data-mode="all"><h2>All cards</h2><p>See every approved person once, in a fresh random order.</p></button></div><label class="range" id="base-size">Adaptive session length: <strong id="length-label">${adaptiveLength}</strong><input id="length" type="range" min="5" max="${Math.max(5, Math.min(50, count))}" value="${adaptiveLength}"></label><div class="actions"><button class="button" id="begin">Begin studying</button></div><div id="setup-notice"></div></section>`);
  document.querySelector('#setup-back').addEventListener('click', event => { event.preventDefault(); courseView(course.id); });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('selected', item === button)); document.querySelector('.range').classList.toggle('hidden', mode === 'all'); document.querySelector('#base-size').firstChild.textContent = mode === 'morris' ? 'Base people: ' : 'Adaptive session length: '; const input = document.querySelector('#length'); input.max = mode === 'morris' ? Math.max(5, Math.min(15, count)) : Math.max(5, Math.min(50, count)); input.value = mode === 'morris' ? Math.min(morrisLength, +input.max) : Math.min(adaptiveLength, +input.max); document.querySelector('#length-label').textContent = input.value; }));
  document.querySelector('#length').addEventListener('input', event => { const length = +event.target.value; if (mode === 'morris') morrisLength = length; else adaptiveLength = length; document.querySelector('#length-label').textContent = length; });
  document.querySelector('#begin').addEventListener('click', async () => { try { const result = await api(`/courses/${course.id}/sessions`, {method:'POST', body:JSON.stringify({mode,limit:+document.querySelector('#length').value})}); initializeStudy(result); await preloadPortrait(currentCard()); studyView(); } catch(error) { document.querySelector('#setup-notice').innerHTML = notice(error.message); } });
}

function initializeStudy(result) {
  study = {...result, index:0, revealed:false};
  if (study.mode === 'morris') {
    study = {...study, remaining:[...result.cards], pending:[], fillers:[...(result.filler_cards || [])], fillerIndex:0, current:null, currentIsFiller:false, stages:{}, reviews:0, maxReviews:Math.min(60, Math.max(20, result.cards.length * 7))};
    advanceMorris();
  }
}

function currentCard() {
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
  const complete = study.mode === 'morris' ? Math.round((study.reviews / study.maxReviews) * 100) : Math.round((study.index / study.cards.length) * 100);
  const sessionTitle = study.mode === 'all' ? 'All cards' : study.mode === 'morris' ? (study.currentIsFiller ? 'Expanding recall · interleaved review' : 'Expanding recall') : 'Adaptive review';
  const position = study.mode === 'morris' ? `${study.reviews + 1} / up to ${study.maxReviews}` : `${study.index + 1} / ${study.cards.length}`;
  const morrisProgress = study.mode === 'morris' ? expandingProgress(card) : '';
  setView(`<div class="study-wrap"><div class="session-meta"><span>${sessionTitle}</span><span>${position}</span></div>${morrisProgress}<div class="study-card" id="flashcard" role="button" tabindex="0" aria-label="Flip card">${portrait(card)}<div class="study-copy">${study.revealed ? `<div class="answer"><div class="eyebrow">The answer</div><div class="name">${esc(card.first_name)} ${esc(card.last_name)}</div>${card.facts.length ? `<ul>${card.facts.map(fact=>`<li>${esc(fact)}</li>`).join('')}</ul>` : ''}</div>` : `<div><div class="eyebrow">Your turn</div><h1>Name this student.</h1><p>Flip when you have an answer in mind.</p></div>`}</div></div><div class="study-actions">${study.revealed ? `<button class="button danger" id="wrong">Wrong <span class="key">W</span></button><button class="button" id="right">Right <span class="key">R</span></button>` : `<button class="button secondary" id="flip">Flip card <span class="key">Space</span></button><button class="button" id="right">Right <span class="key">R</span></button>`}</div><div class="fine" style="margin-top:18px">${complete}% complete · <span class="key">Esc</span> to end session</div></div>`);
  const reveal = () => { if (!study.revealed) { study.revealed = true; studyView(); } };
  document.querySelector('#flashcard').addEventListener('click', reveal); document.querySelector('#flashcard').addEventListener('keydown', event => { if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reveal(); } });
  document.querySelector('#flip')?.addEventListener('click', reveal);
  document.querySelector('#right')?.addEventListener('click', () => score('right'));
  document.querySelector('#wrong')?.addEventListener('click', () => score('wrong'));
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
    await api(`/sessions/${study.id}/reviews`, {method:'POST',body:JSON.stringify({card_id:card.id,result})});
    if (study.mode === 'morris') {
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
  const finishedStudy = study;
  const result = await api(`/sessions/${finishedStudy.id}/complete`, {method:'POST'});
  const accuracy = result.reviewed_count ? Math.round(result.right_count / result.reviewed_count * 100) : 0;
  const restart = finishedStudy.mode === 'all' ? '' : `<button class="button secondary" id="restart-same">Study these ${finishedStudy.cards.length} people again</button>`;
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
      const result = await api(`/courses/${currentCourse.id}/sessions`, {method:'POST', body:JSON.stringify({mode:finishedStudy.mode,limit:finishedStudy.cards.length,card_ids:finishedStudy.cards.map(card => card.id)})});
      initializeStudy(result);
      await preloadPortrait(currentCard());
      studyView();
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  });
}

document.addEventListener('keydown', event => { if (!study || scoring || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return; if ((event.key === ' ' || event.key === 'Enter') && !study.revealed) { event.preventDefault(); study.revealed = true; studyView(); } if (event.key.toLowerCase() === 'r') score('right'); if (study.revealed && event.key.toLowerCase() === 'w') score('wrong'); if (event.key === 'Escape') completeStudy(); });
window.addEventListener('hashchange', route);
async function route() {
  const match = location.hash.match(/^#\/course\/([^/]+)(?:\/(review|add))?$/);
  if (!match) return home();
  const [, courseId, child] = match;
  if (!child) return courseView(courseId);
  try {
    const course = await api(`/courses/${courseId}`);
    if (child === 'review') return candidateView(course, await api(`/courses/${courseId}/candidates`));
    return manualCardView(course);
  } catch (error) {
    setView(`<section class="empty"><h2>That course is unavailable.</h2><p>${esc(error.message)}</p><a class="button" href="#/">Back to courses</a></section>`);
  }
}
route();
