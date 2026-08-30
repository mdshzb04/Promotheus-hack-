const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'gap-history.json');

const TYPE_LABELS = {
  causal_link: "causal 'why' questions",
  mechanism: 'mechanisms (how things work)',
  definition: 'definitions (what things are)',
  scope: 'scope and boundaries',
  analogy: 'analogies and comparisons',
  unknown: 'core concept links',
};

const TYPE_TIPS = {
  causal_link: 'Try focusing on mechanisms, not just definitions, next time you study.',
  mechanism: 'Draw step-by-step cause-and-effect chains when you review.',
  definition: 'Practice stating precise definitions before explaining how things connect.',
  scope: 'Note where a concept applies — and where it stops applying.',
  analogy: 'Test your analogies: where do they break down?',
  unknown: 'Slow down at hand-wavy jumps — ask yourself "but why?" at each step.',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readHistory() {
  ensureDataDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  ensureDataDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

function gapTypesFromSession(session) {
  return session.rounds.filter((r) => r.analysis).map((r) => r.analysis.gap_type);
}

function appendSession(session) {
  const history = readHistory();
  if (history.some((e) => e.sessionId === session.id)) return history;

  const entry = {
    sessionId: session.id,
    topic: session.topic,
    timestamp: new Date().toISOString(),
    gapTypes: gapTypesFromSession(session),
  };
  history.push(entry);
  writeHistory(history);
  return history;
}

function labelForType(type) {
  return TYPE_LABELS[type] || type.replace(/_/g, ' ');
}

function tipForType(type) {
  return TYPE_TIPS[type] || TYPE_TIPS.unknown;
}

function computeInsights(history = readHistory()) {
  const sessionsAnalyzed = history.length;

  if (sessionsAnalyzed < 2) {
    return { sessionsAnalyzed, showInsights: false, patterns: [], message: null };
  }

  const typeCounts = {};
  const typeSessionIds = {};

  for (const entry of history) {
    const seen = new Set();
    for (const type of entry.gapTypes || []) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if (!seen.has(type)) {
        typeSessionIds[type] = typeSessionIds[type] || new Set();
        typeSessionIds[type].add(entry.sessionId);
        seen.add(type);
      }
    }
  }

  const patterns = Object.entries(typeCounts)
    .map(([type, count]) => ({
      type,
      label: labelForType(type),
      count,
      sessionCount: typeSessionIds[type]?.size || 0,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || b.count - a.count)
    .slice(0, 2);

  if (!patterns.length) {
    return { sessionsAnalyzed, showInsights: false, patterns: [], message: null };
  }

  const top = patterns[0];
  const message =
    patterns.length === 1
      ? `You've struggled with ${top.label} in ${top.sessionCount} of your last ${sessionsAnalyzed} sessions — ${tipForType(top.type)}`
      : `Your top blind spots: ${patterns.map((p) => `${p.label} (${p.sessionCount}/${sessionsAnalyzed} sessions)`).join(' · ')}. ${tipForType(top.type)}`;

  return {
    sessionsAnalyzed,
    showInsights: true,
    patterns,
    message,
  };
}

module.exports = {
  appendSession,
  computeInsights,
  readHistory,
  gapTypesFromSession,
  HISTORY_FILE,
};
