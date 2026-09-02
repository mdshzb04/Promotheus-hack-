const crypto = require('crypto');
const { computeMastery, computeLiveMastery, weakestGap, GRADES } = require('./scoring');

const sessions = new Map();
const MAX_QUESTIONS = Number(process.env.MAX_QUESTIONS) || 5;
const MIN_QUESTIONS = Number(process.env.MIN_QUESTIONS) || 2;
const MAX_DEPTH = Number(process.env.MAX_DEPTH) || 2;
const TTL_MS = 60 * 60 * 1000;

function createId() {
  return crypto.randomBytes(8).toString('hex');
}

function createSession(topic, explanation, { fromNotes = false } = {}) {
  const id = createId();
  const session = {
    id,
    topic: topic.trim(),
    fromNotes,
    rounds: [{ userText: explanation.trim(), analysis: null, question: null, answer: null }],
    focusTopic: null,
    depthOnFocus: 0,
    createdAt: Date.now(),
    complete: false,
    gapMap: null,
    microLessons: null,
    mastery: null,
    expertSnapshot: null,
    coachNote: null,
    proveIt: null,
    scoreHistory: [],
    initialExplanation: explanation.trim(),
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function recordAnalysis(session, analysis) {
  const round = session.rounds.at(-1);
  round.analysis = analysis;
  round.question = analysis.question;
  const gapMap = buildGapMap(session);
  const live = computeLiveMastery(session, gapMap);
  session.scoreHistory.push({
    score: live.score,
    gapTopic: analysis.gap_topic,
    gapDetected: analysis.gap_detected,
  });
}

function recordAnswer(session, answer) {
  session.rounds.at(-1).answer = answer.trim();
}

function startNextRound(session, answer) {
  recordAnswer(session, answer);
  session.rounds.push({ userText: answer.trim(), analysis: null, question: null, answer: null });
}

function questionCount(session) {
  return session.rounds.filter((r) => r.question).length;
}

function distinctConcepts(session) {
  return new Set(session.rounds.filter((r) => r.analysis).map((r) => r.analysis.gap_topic)).size;
}

function buildGapMap(session) {
  const concepts = new Map();

  for (const round of session.rounds) {
    if (!round.analysis) continue;
    const topic = round.analysis.gap_topic;
    concepts.set(topic, {
      topic,
      gap_type: round.analysis.gap_type,
      status: round.analysis.gap_detected ? 'shaky' : 'solid',
      severity: round.analysis.severity || 'none',
      question: round.question,
    });
  }

  return [...concepts.values()];
}

/** Adaptive routing: deepen on severe gaps, explore when solid */
function planNextStep(session) {
  const last = session.rounds.at(-1);
  const q = questionCount(session);
  let routing = { mode: 'explore' };

  if (last?.analysis) {
    const { gap_detected, gap_topic, severity } = last.analysis;
    if (gap_detected && (severity === 'severe' || severity === 'moderate')) {
      const sameFocus = session.focusTopic === gap_topic;
      const depth = sameFocus ? session.depthOnFocus || 0 : 0;
      if (depth < MAX_DEPTH) {
        routing = { mode: 'deepen', focus: gap_topic, severity };
      }
    }
  }

  if (q >= MAX_QUESTIONS) return { complete: true, routing };
  if (q < MIN_QUESTIONS) return { complete: false, routing };

  if (routing.mode === 'deepen') return { complete: false, routing };

  if (last?.analysis) {
    const { gap_detected, severity } = last.analysis;
    if (!gap_detected && distinctConcepts(session) >= 2) return { complete: true, routing };
    if (q >= 3 && (!gap_detected || severity === 'mild')) return { complete: true, routing };
  }

  return { complete: false, routing };
}

function applyRoutingState(session, routing) {
  if (routing.mode === 'deepen') {
    if (session.focusTopic !== routing.focus) {
      session.focusTopic = routing.focus;
      session.depthOnFocus = 1;
    } else {
      session.depthOnFocus += 1;
    }
  } else {
    session.focusTopic = null;
    session.depthOnFocus = 0;
  }
}

function finalizeSession(session, report) {
  session.complete = true;
  session.gapMap = buildGapMap(session);
  session.microLessons = report.microLessons;
  session.analogies = report.analogies || [];
  session.expertSnapshot = report.expertSnapshot;
  session.coachNote = report.coachNote;
  session.mastery = computeMastery(session.gapMap, session.rounds);
  session.proveIt = weakestGap(session.gapMap);
}

function applyProveIt(session, result) {
  session.proveItResult = result;
  if (!session.gapMap?.length || !session.proveIt) return;

  if (result.closed) {
    const topic = session.proveIt.topic;
    session.gapMap = session.gapMap.map((g) =>
      g.topic === topic ? { ...g, status: 'solid', severity: 'none' } : g
    );
    session.mastery = computeMastery(session.gapMap, session.rounds);
    session.scoreHistory.push({
      score: session.mastery.score,
      gapTopic: topic,
      gapDetected: false,
    });
    return;
  }

  if (session.mastery && result.scoreDelta) {
    const score = Math.min(100, session.mastery.score + result.scoreDelta);
    const gradeRow = GRADES.find(([min]) => score >= min) || GRADES.at(-1);
    session.mastery = {
      ...session.mastery,
      score,
      grade: gradeRow[1],
      verdict: gradeRow[2],
    };
  }
}

function publicView(session) {
  const gapMap = session.complete ? session.gapMap : buildGapMap(session);
  const liveMastery = computeLiveMastery(session, gapMap);

  return {
    id: session.id,
    topic: session.topic,
    fromNotes: session.fromNotes,
    adaptive: true,
    questionCount: questionCount(session),
    maxQuestions: MAX_QUESTIONS,
    minQuestions: MIN_QUESTIONS,
    currentRound: session.rounds.length,
    complete: session.complete,
    routing: session.lastRouting || null,
    liveMastery,
    rounds: session.rounds.map((r, i) => ({
      round: i + 1,
      userText: r.userText,
      question: r.question,
      answer: r.answer,
      analysis: r.analysis
        ? {
            gap_detected: r.analysis.gap_detected,
            gap_type: r.analysis.gap_type,
            gap_topic: r.analysis.gap_topic,
            severity: r.analysis.severity || 'none',
            weak_phrase: r.analysis.weak_phrase || '',
          }
        : null,
    })),
    scoreHistory: session.scoreHistory,
    initialExplanation: session.initialExplanation,
    gapMap: session.complete ? session.gapMap : gapMap,
    microLessons: session.microLessons,
    analogies: session.analogies,
    mastery: session.complete ? session.mastery : liveMastery,
    expertSnapshot: session.expertSnapshot,
    coachNote: session.coachNote,
    proveIt: session.proveIt,
    proveItResult: session.proveItResult || null,
  };
}

function buildMarkdownReport(session) {
  const v = publicView(session);
  const lines = [
    `# Feynman Gap Report — ${v.topic}`,
    '',
    `**Mastery Score:** ${v.mastery?.score ?? '—'}/100 (${v.mastery?.grade ?? '—'})`,
    `> ${v.mastery?.verdict ?? ''}`,
    '',
  ];
  if (v.expertSnapshot) {
    lines.push('## Expert Snapshot', v.expertSnapshot, '');
  }
  if (v.coachNote) {
    lines.push('## Coach Note', v.coachNote, '');
  }
  lines.push('## Gap Map', '');
  for (const g of v.gapMap || []) {
    const icon = g.status === 'solid' ? '✅' : '⚠️';
    lines.push(`- ${icon} **${g.topic}** (${g.gap_type}) — ${g.status}`);
    const lesson = v.microLessons?.find((l) => l.gap_topic === g.topic);
    if (lesson) lines.push(`  - Micro-lesson: ${lesson.lesson}`);
  }
  if (v.proveItResult) {
    lines.push('', '## Prove-It Result', v.proveItResult.feedback);
  }
  lines.push('', '---', '*Generated by Feynman Gap Finder*');
  return lines.join('\n');
}

module.exports = {
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  MAX_DEPTH,
  createSession,
  getSession,
  recordAnalysis,
  recordAnswer,
  startNextRound,
  questionCount,
  planNextStep,
  applyRoutingState,
  buildGapMap,
  finalizeSession,
  applyProveIt,
  publicView,
  buildMarkdownReport,
  _sessions: sessions,
};
