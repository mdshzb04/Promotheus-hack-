import { renderGapGraph, animateScoreRing, launchConfetti } from './gap-graph.js';
import { createVoiceInput, typewriter } from './voice.js';
import { renderHeatmapPanel } from './heatmap.js';
import { renderJourney } from './journey.js';
import { speak, wireTtsToggle } from './tts.js';
import { renderFlashcards } from './flashcards.js';

const DEMO = {
  topic: 'Why photosynthesis needs light and dark reactions',
  explanation:
    'Plants use sunlight in the light reactions to make ATP and NADPH, then the Calvin cycle in the stroma uses those to fix CO₂ into sugar. The light reactions happen in the thylakoid membranes and split water to release oxygen. Dark reactions don\'t need light directly but they need the products from the light stage, which is why both parts are required.',
};

const DEMO_NOTES = `Photosynthesis occurs in chloroplasts and has two stages. The light-dependent reactions take place in the thylakoid membranes where chlorophyll absorbs photons, splitting water (photolysis) to release O₂ and producing ATP and NADPH. The Calvin cycle (light-independent reactions) occurs in the stroma, using ATP and NADPH to fix atmospheric CO₂ into G3P, which is used to synthesize glucose. The two stages are coupled — Calvin cycle cannot run without the energy carriers from the light reactions.`;

const $ = (sel) => document.querySelector(sel);

const topicInput = $('#topic');
const explanationInput = $('#explanation');
const notesInput = $('#notes-input');
const notesExplanation = $('#notes-explanation');
const extractBtn = $('#extract-btn');
const extractResult = $('#extract-result');
const extractTopic = $('#extract-topic');
const extractSummary = $('#extract-summary');
const extractPreview = $('#extract-preview');
const notesFile = $('#notes-file');
const pdfFile = $('#pdf-file');
const explainPdfFile = $('#explain-pdf-file');
const startBtn = $('#start-btn');
const demoBtn = $('#demo-btn');
const setupPanel = $('#setup-panel');
const chatPanel = $('#chat-panel');
const gapPanel = $('#gap-panel');
const chatThread = $('#chat-thread');
const activeTopic = $('#active-topic');
const roundStepper = $('#round-stepper');
const liveScoreValue = $('#live-score-value');
const liveScoreFill = $('#live-score-fill');
const liveGapZone = $('#live-gap-zone');
const routingBadge = $('#routing-badge');
const heatmapPanel = $('#heatmap-panel');
const journeyLive = $('#journey-live');
const journeyFinal = $('#journey-final');
const compareCard = $('#compare-card');
const compareYours = $('#compare-yours');
const compareExpert = $('#compare-expert');
const recurringCard = $('#recurring-card');
const recurringText = $('#recurring-text');
const recurringTags = $('#recurring-tags');
const flashcardsPanel = $('#flashcards-panel');
const flashcardsGrid = $('#flashcards-grid');
const shareLinkBtn = $('#share-link-btn');
const answerInput = $('#answer');
const submitAnswerBtn = $('#submit-answer-btn');
const answerArea = $('#answer-area');
const gapMap = $('#gap-map');
const gapGraph = $('#gap-graph');
const restartBtn = $('#restart-btn');
const statusEl = $('#status');
const scoreValue = $('#score-value');
const scoreGrade = $('#score-grade');
const scoreVerdict = $('#score-verdict');
const scoreStats = $('#score-stats');
const expertCard = $('#expert-card');
const expertText = $('#expert-text');
const coachCard = $('#coach-card');
const coachText = $('#coach-text');
const proveItPanel = $('#prove-it-panel');
const proveItPrompt = $('#prove-it-prompt');
const proveItInput = $('#prove-it-input');
const proveItBtn = $('#prove-it-btn');
const proveItResult = $('#prove-it-result');
const copyReportBtn = $('#copy-report-btn');
const confettiLayer = $('#confetti-layer');

let sessionId = null;
let busy = false;
let maxQuestions = 5;
let activeTab = 'explain';
let extractedTopic = null;
let initialExplanation = '';
let collectedAnalyses = [];

createVoiceInput($('#voice-explain-btn'), explanationInput);
createVoiceInput($('#voice-answer-btn'), answerInput);
wireTtsToggle($('#tts-toggle'));

notesExplanation.addEventListener('focus', () => notesInput.classList.add('blurred'));
notesExplanation.addEventListener('blur', () => {
  if (!notesExplanation.value.trim()) notesInput.classList.remove('blurred');
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#tab-explain').classList.toggle('hidden', activeTab !== 'explain');
    $('#tab-notes').classList.toggle('hidden', activeTab !== 'notes');
  });
});

notesFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  notesInput.value = await file.text();
  e.target.value = '';
});

pdfFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) uploadPdf(file, { fillNotes: true });
});

explainPdfFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) uploadPdf(file, { fillTopic: true });
});

extractBtn.addEventListener('click', extractNotes);

function showStatus(msg, type = 'loading') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

function setBusy(on) {
  busy = on;
  startBtn.disabled = on;
  submitAnswerBtn.disabled = on;
  demoBtn.disabled = on;
  proveItBtn.disabled = on;
  extractBtn.disabled = on;
  pdfFile.disabled = on;
  explainPdfFile.disabled = on;
}

function updateLiveScore(mastery) {
  if (!mastery) return;
  liveScoreValue.textContent = `${mastery.score}%`;
  liveScoreFill.style.width = `${mastery.score}%`;
  liveGapZone.style.width = `${mastery.gapPercent ?? 0}%`;
}

function showRouting(routing) {
  if (!routing) {
    routingBadge.classList.add('hidden');
    return;
  }
  routingBadge.classList.remove('hidden');
  if (routing.mode === 'deepen') {
    routingBadge.className = 'routing-badge';
    routingBadge.textContent = `↳ Digging deeper: ${routing.focus}`;
  } else {
    routingBadge.className = 'routing-badge explore';
    routingBadge.textContent = '→ Exploring next sub-concept';
  }
}

function renderStepper(current, total) {
  roundStepper.innerHTML = '';
  for (let i = 1; i <= total; i++) {
    const dot = document.createElement('span');
    dot.className = 'step-dot';
    if (i < current) dot.classList.add('done');
    else if (i === current) dot.classList.add('active');
    dot.title = `Question ${i} of up to ${total}`;
    roundStepper.appendChild(dot);
  }
}

function appendBubble(role, text, { analysis, animate = false } = {}) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.innerHTML = `<div class="role">${role === 'user' ? 'You' : 'Curious listener'}</div><div class="text"></div>`;
  const textEl = div.querySelector('.text');
  chatThread.appendChild(div);

  if (animate && role === 'ai') {
    typewriter(textEl, text).then(() => speak(text));
  } else {
    textEl.textContent = text;
    if (role === 'ai') speak(text);
  }

  if (analysis && role === 'ai') {
    const chip = document.createElement('div');
    const shaky = analysis.gap_detected;
    chip.className = `gap-chip ${shaky ? 'shaky' : 'solid'}`;
    const sev = analysis.severity && analysis.severity !== 'none' ? ` · ${analysis.severity}` : '';
    chip.textContent = shaky
      ? `Gap: ${analysis.gap_topic}${sev}`
      : `Solid: ${analysis.gap_topic}`;
    div.appendChild(chip);
  }

  chatThread.scrollTop = chatThread.scrollHeight;
  return div;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderGapMap(session) {
  gapMap.innerHTML = '';
  const lessonsByTopic = Object.fromEntries(
    (session.microLessons || []).map((l) => [l.gap_topic, l.lesson])
  );

  (session.gapMap || []).forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `gap-item ${item.status}`;
    el.style.animationDelay = `${i * 0.08}s`;
    const lesson = item.status === 'shaky' ? lessonsByTopic[item.topic] : null;
    el.innerHTML = `
      <div class="gap-header">
        <span class="gap-badge ${item.status}">${item.status === 'solid' ? 'Solid' : 'Shaky'}</span>
        <span class="gap-topic">${escapeHtml(item.topic)}</span>
      </div>
      <div class="gap-type">${escapeHtml(item.gap_type)}</div>
      ${lesson ? `<div class="micro-lesson"><strong>Micro-lesson</strong>${escapeHtml(lesson)}</div>` : ''}
    `;
    gapMap.appendChild(el);
  });
}

function pushGapToRoom(session) {
  const roomCode = localStorage.getItem('studyRoomCode');
  const memberToken = localStorage.getItem('studyRoomToken');
  if (!roomCode || !memberToken || !session?.gapMap) return;
  fetch(`/api/room/${roomCode}/gap-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      memberToken,
      topic: session.topic,
      gapMap: session.gapMap,
      mastery: session.mastery || session.liveMastery,
      sessionId: session.id,
    }),
  }).catch(() => {});
}

function updateSessionUI(session, analysis) {
  updateLiveScore(session.liveMastery);
  if (analysis) collectedAnalyses.push(analysis);
  renderHeatmapPanel(heatmapPanel, initialExplanation, collectedAnalyses);
  if (session.scoreHistory?.length >= 2) {
    journeyLive.classList.remove('hidden');
    renderJourney(journeyLive, session.scoreHistory);
  }
  pushGapToRoom(session);
}

function renderResults(session) {
  const m = session.mastery || {};

  scoreValue.textContent = m.score ?? '—';
  scoreGrade.textContent = m.grade ?? '';
  scoreVerdict.textContent = m.verdict ?? '';
  scoreStats.innerHTML = `
    <span><strong>${m.solid ?? 0}</strong> solid</span>
    <span><strong>${m.shaky ?? 0}</strong> shaky</span>
    <span><strong>${m.total ?? 0}</strong> concepts</span>
  `;

  animateScoreRing(document.querySelector('.score-ring'), m.score || 0);

  if (session.expertSnapshot) {
    expertCard.classList.remove('hidden');
    expertText.textContent = session.expertSnapshot;
    compareCard.classList.remove('hidden');
    compareYours.textContent = session.initialExplanation || initialExplanation;
    compareExpert.textContent = session.expertSnapshot;
  }
  if (session.coachNote) {
    coachCard.classList.remove('hidden');
    coachText.textContent = session.coachNote;
  }

  renderJourney(journeyFinal, session.scoreHistory);
  renderGapGraph(gapGraph, session.topic, session.gapMap);
  renderGapMap(session);
  renderFlashcards(flashcardsGrid, session.gapMap, session.microLessons, session.analogies);
  flashcardsPanel.classList.toggle('hidden', !(session.gapMap || []).some((g) => g.status === 'shaky'));
  renderHeatmapPanel(heatmapPanel, session.initialExplanation || initialExplanation, collectedAnalyses);

  if (session.proveIt && !session.proveItResult) {
    proveItPanel.classList.remove('hidden');
    proveItPrompt.textContent = `Re-explain "${session.proveIt.topic}" — your weakest spot. Can you close the gap?`;
  } else {
    proveItPanel.classList.add('hidden');
  }

  if (m.score >= 85) launchConfetti(confettiLayer);
  loadRecurringInsights();
  pushGapToRoom(session);
}

async function loadRecurringInsights() {
  try {
    const res = await fetch('/api/insights');
    const data = await res.json();
    if (!data.showInsights || !data.message) {
      recurringCard.classList.add('hidden');
      return;
    }
    recurringCard.classList.remove('hidden');
    recurringText.textContent = data.message;
    recurringTags.innerHTML = (data.patterns || [])
      .map(
        (p) =>
          `<span class="recurring-tag">${escapeHtml(p.label)} · ${p.sessionCount}/${data.sessionsAnalyzed}</span>`
      )
      .join('');
  } catch {
    recurringCard.classList.add('hidden');
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showExtractResult(data) {
  extractedTopic = data.topic;
  extractTopic.textContent = data.topic;
  extractSummary.textContent = data.summary;
  if (data.previewQuestion) {
    extractPreview.textContent = `First question preview: ${data.previewQuestion}`;
    extractPreview.classList.remove('hidden');
  } else {
    extractPreview.classList.add('hidden');
    extractPreview.textContent = '';
  }
  extractResult.classList.remove('hidden');
}

async function uploadPdf(file, { fillNotes = false, fillTopic = false } = {}) {
  if (file.size > 50 * 1024 * 1024) {
    showStatus('File too large — max 50MB', 'error');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    showStatus('PDF only — upload a .pdf file.', 'error');
    return;
  }

  setBusy(true);
  showStatus('Extracting text…');
  const analyzeTimer = setTimeout(() => {
    if (busy) showStatus('Analyzing document…');
  }, 900);

  const form = new FormData();
  form.append('pdf', file);

  try {
    const res = await fetch('/api/extract-pdf', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PDF extraction failed');

    if (fillNotes) {
      document.querySelector('.tab[data-tab="notes"]').click();
      showExtractResult(data);
    }
    if (fillTopic) {
      document.querySelector('.tab[data-tab="explain"]').click();
      topicInput.value = data.topic;
      extractedTopic = data.topic;
      if (data.previewQuestion) {
        showStatus(`Topic ready — preview: "${data.previewQuestion}"`, 'success');
        setTimeout(hideStatus, 4000);
        return;
      }
    }
    hideStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    clearTimeout(analyzeTimer);
    setBusy(false);
  }
}

async function extractNotes() {
  const notes = notesInput.value.trim();
  if (notes.length < 40) {
    showStatus('Paste at least a paragraph of notes.', 'error');
    return;
  }
  setBusy(true);
  showStatus('Extracting topic from your notes…');
  try {
    const data = await api('/api/extract-notes', { notes });
    showExtractResult(data);
    hideStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function getStartPayload() {
  if (activeTab === 'notes') {
    const topic = extractedTopic || extractTopic.textContent;
    const explanation = notesExplanation.value.trim();
    if (!topic) throw new Error('Extract a topic from your notes first.');
    if (!explanation) throw new Error('Explain the topic in your own words.');
    return { topic, explanation, fromNotes: true };
  }
  const topic = topicInput.value.trim();
  const explanation = explanationInput.value.trim();
  if (!topic || !explanation) throw new Error('Enter a topic and explanation.');
  return { topic, explanation, fromNotes: false };
}

async function startSession() {
  let payload;
  try {
    payload = getStartPayload();
  } catch (err) {
    showStatus(err.message, 'error');
    return;
  }

  setBusy(true);
  showStatus('Analyzing your explanation…');

  try {
    const data = await api('/api/start', payload);
    sessionId = data.session.id;
    maxQuestions = data.session.maxQuestions;
    initialExplanation = payload.explanation;
    collectedAnalyses = [data.analysis];

    setupPanel.classList.add('hidden');
    chatPanel.classList.remove('hidden');
    gapPanel.classList.add('hidden');
    chatThread.innerHTML = '';
    heatmapPanel.classList.add('hidden');
    journeyLive.classList.add('hidden');
    activeTopic.textContent = payload.topic;
    renderStepper(1, maxQuestions);
    updateSessionUI(data.session, data.analysis);
    showRouting(data.session.routing);

    appendBubble('user', payload.explanation);
    appendBubble('ai', data.question, { analysis: data.analysis, animate: true });
    answerInput.value = '';
    answerArea.classList.remove('hidden');
    hideStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function submitAnswer() {
  const answer = answerInput.value.trim();
  if (!answer || !sessionId) return;

  setBusy(true);
  appendBubble('user', answer);
  answerInput.value = '';
  routingBadge.classList.add('hidden');
  const thinking = appendBubble('ai', '');
  thinking.classList.add('thinking');
  thinking.querySelector('.text').innerHTML = '<span class="radar-pulse"></span> Probing for gaps…';

  try {
    const data = await api('/api/answer', { sessionId, answer });
    thinking.remove();

    if (data.complete) {
      answerArea.classList.add('hidden');
      chatPanel.classList.add('hidden');
      gapPanel.classList.remove('hidden');
      renderResults(data.session);
      hideStatus();
    } else {
      renderStepper(data.session.questionCount, maxQuestions);
      updateSessionUI(data.session, data.analysis);
      showRouting(data.routing);
      appendBubble('ai', data.question, { analysis: data.analysis, animate: true });
      hideStatus();
    }
  } catch (err) {
    thinking.remove();
    showStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function submitProveIt() {
  const explanation = proveItInput.value.trim();
  if (!explanation || !sessionId) return;

  setBusy(true);
  showStatus('Grading your prove-it…');

  try {
    const data = await api('/api/prove-it', { sessionId, explanation });
    const r = data.result;
    if (r) {
      proveItResult.classList.remove('hidden');
      proveItResult.className = `prove-it-result ${r.closed ? 'closed' : 'open'}`;
      proveItResult.textContent = r.feedback;
      proveItBtn.disabled = true;
      if (data.session.mastery) {
        scoreValue.textContent = data.session.mastery.score;
        animateScoreRing(document.querySelector('.score-ring'), data.session.mastery.score);
      }
      if (r.closed) launchConfetti(confettiLayer);
    }
    hideStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function shareLink() {
  if (!sessionId) return;
  const url = `${location.origin}/share.html?id=${sessionId}`;
  try {
    await navigator.clipboard.writeText(url);
    showStatus('Share link copied!', 'success');
    setTimeout(hideStatus, 2000);
  } catch {
    showStatus(url, 'success');
  }
}

async function copyReport() {
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/session/${sessionId}/report`);
    const data = await res.json();
    await navigator.clipboard.writeText(data.markdown);
    showStatus('Report copied to clipboard!', 'success');
    setTimeout(hideStatus, 2000);
  } catch {
    showStatus('Could not copy report.', 'error');
  }
}

function loadDemo() {
  document.querySelector('.tab[data-tab="explain"]').click();
  topicInput.value = DEMO.topic;
  explanationInput.value = DEMO.explanation;
}

function loadNotesDemo() {
  document.querySelector('.tab[data-tab="notes"]').click();
  notesInput.value = DEMO_NOTES;
}

function restart() {
  sessionId = null;
  extractedTopic = null;
  initialExplanation = '';
  collectedAnalyses = [];
  setupPanel.classList.remove('hidden');
  chatPanel.classList.add('hidden');
  gapPanel.classList.add('hidden');
  chatThread.innerHTML = '';
  gapMap.innerHTML = '';
  gapGraph.innerHTML = '';
  journeyLive.innerHTML = '';
  journeyFinal.innerHTML = '';
  expertCard.classList.add('hidden');
  coachCard.classList.add('hidden');
  compareCard.classList.add('hidden');
  recurringCard.classList.add('hidden');
  recurringTags.innerHTML = '';
  flashcardsPanel.classList.add('hidden');
  flashcardsGrid.innerHTML = '';
  proveItPanel.classList.add('hidden');
  proveItResult.classList.add('hidden');
  proveItInput.value = '';
  proveItBtn.disabled = false;
  routingBadge.classList.add('hidden');
  heatmapPanel.classList.add('hidden');
  journeyLive.classList.add('hidden');
  extractResult.classList.add('hidden');
  extractPreview.classList.add('hidden');
  extractPreview.textContent = '';
  notesInput.classList.remove('blurred');
  hideStatus();
}

startBtn.addEventListener('click', startSession);
demoBtn.addEventListener('click', loadDemo);
submitAnswerBtn.addEventListener('click', submitAnswer);
proveItBtn.addEventListener('click', submitProveIt);
copyReportBtn.addEventListener('click', copyReport);
shareLinkBtn.addEventListener('click', shareLink);
restartBtn.addEventListener('click', restart);

answerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAnswer();
});

loadDemo();
