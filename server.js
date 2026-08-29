require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  askGapQuestion,
  extractFromNotes,
  generateSessionReport,
  gradeProveIt,
  buildTranscript,
  getProvider,
} = require('./lib/ai');
const sessionStore = require('./lib/session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function analysisPayload(a) {
  return {
    gap_detected: a.gap_detected,
    gap_type: a.gap_type,
    gap_topic: a.gap_topic,
    severity: a.severity,
    weak_phrase: a.weak_phrase || '',
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: getProvider() || 'none',
    adaptive: true,
    maxQuestions: sessionStore.MAX_QUESTIONS,
  });
});

app.get('/api/session/:id', (req, res) => {
  const session = sessionStore.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
  res.json({ session: sessionStore.publicView(session) });
});

app.get('/api/session/:id/report', (req, res) => {
  const session = sessionStore.getSession(req.params.id);
  if (!session?.complete) return res.status(404).json({ error: 'Report not ready.' });
  res.json({
    markdown: sessionStore.buildMarkdownReport(session),
    session: sessionStore.publicView(session),
  });
});

app.post('/api/extract-notes', async (req, res) => {
  try {
    const { notes } = req.body || {};
    if (!notes?.trim() || notes.trim().length < 40) {
      return res.status(400).json({ error: 'Paste at least a paragraph of notes (40+ chars).' });
    }
    const extracted = await extractFromNotes(notes.trim());
    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to extract topic.' });
  }
});

app.post('/api/start', async (req, res) => {
  try {
    const { topic, explanation, fromNotes } = req.body || {};
    if (!topic?.trim() || !explanation?.trim()) {
      return res.status(400).json({ error: 'Topic and explanation are required.' });
    }
    if (explanation.trim().length < 20) {
      return res.status(400).json({ error: 'Write at least 2-4 sentences (20+ chars).' });
    }

    const session = sessionStore.createSession(topic, explanation, { fromNotes: !!fromNotes });
    const analysis = await askGapQuestion(session, { mode: 'explore' });
    sessionStore.recordAnalysis(session, analysis);
    session.lastRouting = { mode: 'explore' };

    res.json({
      session: sessionStore.publicView(session),
      question: analysis.question,
      analysis: analysisPayload(analysis),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to start session.' });
  }
});

app.post('/api/answer', async (req, res) => {
  try {
    const { sessionId, answer } = req.body || {};
    if (!sessionId || !answer?.trim()) {
      return res.status(400).json({ error: 'sessionId and answer are required.' });
    }

    const session = sessionStore.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
    if (session.complete) return res.status(400).json({ error: 'Session already complete.' });
    if (!session.rounds.at(-1).question) {
      return res.status(400).json({ error: 'No pending question for this round.' });
    }

    sessionStore.recordAnswer(session, answer);
    const { complete, routing } = sessionStore.planNextStep(session);

    if (complete) {
      const shakyGaps = sessionStore
        .buildGapMap(session)
        .filter((g) => g.status === 'shaky')
        .map((g) => ({
          gap_topic: g.topic,
          gap_type: g.gap_type,
          question: g.question,
        }));

      const report = await generateSessionReport(
        session.topic,
        shakyGaps,
        buildTranscript(session)
      );
      sessionStore.finalizeSession(session, report);

      return res.json({
        complete: true,
        session: sessionStore.publicView(session),
      });
    }

    sessionStore.applyRoutingState(session, routing);
    session.lastRouting = routing;
    sessionStore.startNextRound(session, answer);
    const analysis = await askGapQuestion(session, routing);
    sessionStore.recordAnalysis(session, analysis);

    res.json({
      complete: false,
      routing,
      question: analysis.question,
      analysis: analysisPayload(analysis),
      session: sessionStore.publicView(session),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to process answer.' });
  }
});

app.post('/api/prove-it', async (req, res) => {
  try {
    const { sessionId, explanation } = req.body || {};
    if (!sessionId || !explanation?.trim()) {
      return res.status(400).json({ error: 'sessionId and explanation are required.' });
    }

    const session = sessionStore.getSession(sessionId);
    if (!session?.complete) return res.status(400).json({ error: 'Complete a session first.' });
    if (!session.proveIt) {
      return res.json({ skipped: true, session: sessionStore.publicView(session) });
    }
    if (session.proveItResult) {
      return res.json({ session: sessionStore.publicView(session) });
    }

    const result = await gradeProveIt(
      session.topic,
      session.proveIt.topic,
      session.proveIt.gap_type,
      explanation.trim()
    );
    sessionStore.applyProveIt(session, result);

    res.json({ result, session: sessionStore.publicView(session) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Prove-it grading failed.' });
  }
});

app.listen(PORT, () => {
  const provider = getProvider();
  console.log(`Feynman Gap Finder → http://localhost:${PORT}`);
  if (!provider) {
    console.warn('⚠  No API key found. Copy .env.example → .env and add OPENAI_API_KEY or ANTHROPIC_API_KEY');
  } else {
    console.log(`AI provider: ${provider} · adaptive routing on`);
  }
});
