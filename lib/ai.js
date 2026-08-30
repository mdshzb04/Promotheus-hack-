const QUESTION_SYSTEM_PROMPT = `You are simulating a curious, intelligent listener with no prior expertise in this topic. Given the user's explanation, ask exactly ONE short clarifying question targeting the weakest or least justified part of it — like a smart child asking 'but why' at the exact point a claim goes unexplained. Don't praise or criticize. Don't question parts already well explained.

Respond with ONLY valid JSON (no markdown fences):
{
  "question": "your single clarifying question",
  "gap_detected": true or false,
  "gap_type": "short label e.g. causal_link, mechanism, definition, scope, analogy",
  "gap_topic": "the specific sub-concept where the gap lives",
  "severity": "none | mild | moderate | severe — how big the gap is (none if gap_detected is false)",
  "weak_phrase": "exact quote from the user's text (5-15 words) where the gap is most visible — empty string if none"
}`;

const MICRO_LESSON_SYSTEM = `You write ultra-short micro-lessons (2-3 sentences) that patch ONE specific knowledge gap. Be concrete. No preamble, no praise. Address only the gap described.`;

const REPORT_SYSTEM = `You are a Feynman Technique coach. Be concise, precise, encouraging without fluff.`;

const EXTRACT_SYSTEM = `You extract testable topics from study notes. Pick the single best concept the student should explain in their own words to prove understanding.`;

function getProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

async function chat(messages, { system, json = false } = {}) {
  const provider = getProvider();
  if (!provider) {
    throw new Error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env');
  }

  if (provider === 'openai') {
    const body = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      temperature: 0.7,
    };
    if (json) body.response_format = { type: 'json_object' };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${err}`);
    }
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: system || '',
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function normalizeAnalysis(parsed) {
  if (!parsed.question || typeof parsed.gap_detected !== 'boolean') {
    throw new Error('AI returned invalid question payload');
  }
  const severity = parsed.gap_detected
    ? String(parsed.severity || 'moderate')
    : 'none';
  return {
    question: String(parsed.question),
    gap_detected: Boolean(parsed.gap_detected),
    gap_type: String(parsed.gap_type || 'unknown'),
    gap_topic: String(parsed.gap_topic || 'general'),
    severity,
    weak_phrase: String(parsed.weak_phrase || ''),
  };
}

function buildQuestionContext(session, routing) {
  const lines = [`Topic: ${session.topic}`, ''];

  if (routing?.mode === 'deepen') {
    lines.push(
      `ROUTING: User still has a ${routing.severity} gap on "${routing.focus}". Ask a DEEPER follow-up on this SAME sub-concept — go one level deeper (mechanism, causality, or edge case). Do NOT switch topics.`
    );
    lines.push('');
  } else if (session.rounds.some((r) => r.analysis && !r.analysis.gap_detected)) {
    lines.push(
      'ROUTING: Prior sub-concept was solid. Move to a NEW sub-concept — find the next weakest part of their explanation.'
    );
    lines.push('');
  }

  session.rounds.forEach((r, i) => {
    lines.push(`--- Exchange ${i + 1} ---`);
    lines.push(`User said: ${r.userText}`);
    if (r.analysis) {
      lines.push(
        `(Gap: ${r.analysis.gap_topic}, type: ${r.analysis.gap_type}, severity: ${r.analysis.severity}, detected: ${r.analysis.gap_detected})`
      );
    }
    if (r.question) lines.push(`You asked: ${r.question}`);
    if (r.answer) lines.push(`User answered: ${r.answer}`);
    lines.push('');
  });

  lines.push('Ask your ONE new clarifying question. Avoid repeating prior questions.');
  return lines.join('\n');
}

async function askGapQuestion(session, routing = { mode: 'explore' }) {
  const context =
    session.rounds.length > 1 || routing.mode === 'deepen'
      ? buildQuestionContext(session, routing)
      : session.rounds.at(-1).userText;

  const raw = await chat([{ role: 'user', content: context }], {
    system: QUESTION_SYSTEM_PROMPT,
    json: !!process.env.OPENAI_API_KEY,
  });

  return normalizeAnalysis(parseJson(raw));
}

async function extractFromNotes(notes) {
  const raw = await chat(
    [
      {
        role: 'user',
        content: `Study notes (paste from textbook, slides, etc.):

${notes}

Return JSON:
{
  "topic": "short, testable topic the student should explain (5-12 words)",
  "summary": "one sentence summarizing what these notes cover",
  "key_concepts": ["sub-concept 1", "sub-concept 2", "sub-concept 3"]
}`,
      },
    ],
    { system: EXTRACT_SYSTEM, json: !!process.env.OPENAI_API_KEY }
  );

  const parsed = parseJson(raw);
  if (!parsed.topic?.trim()) throw new Error('Could not extract a topic from notes');
  return {
    topic: String(parsed.topic).trim(),
    summary: String(parsed.summary || ''),
    keyConcepts: (parsed.key_concepts || []).map(String),
  };
}

async function generateSessionReport(topic, gaps, transcript) {
  const gapList = gaps.length
    ? gaps.map((g) => `- ${g.gap_topic} (${g.gap_type})`).join('\n')
    : 'No gaps detected';

  const raw = await chat(
    [
      {
        role: 'user',
        content: `Topic: "${topic}"

Gaps found:
${gapList}

Conversation transcript:
${transcript}

Return JSON:
{
  "expert_snapshot": "One crisp sentence — how an expert would explain the core idea",
  "lessons": [{"gap_topic":"exact match","lesson":"2-3 sentence micro-lesson"}],
  "analogies": [{"gap_topic":"exact match","analogy":"One vivid analogy or metaphor that makes this click"}],
  "coach_note": "One sentence personalized coaching tip based on their specific gaps"
}

Include a lesson AND analogy for EVERY shaky gap. Match gap_topic strings exactly.`,
      },
    ],
    { system: MICRO_LESSON_SYSTEM, json: !!process.env.OPENAI_API_KEY }
  );

  const parsed = parseJson(raw);
  return {
    expertSnapshot: String(parsed.expert_snapshot || ''),
    microLessons: (parsed.lessons || []).map((l) => ({
      gap_topic: String(l.gap_topic),
      lesson: String(l.lesson),
    })),
    analogies: (parsed.analogies || []).map((a) => ({
      gap_topic: String(a.gap_topic),
      analogy: String(a.analogy),
    })),
    coachNote: String(parsed.coach_note || ''),
  };
}

async function gradeProveIt(topic, gapTopic, gapType, userExplanation) {
  const raw = await chat(
    [
      {
        role: 'user',
        content: `Topic: ${topic}
Gap being tested: "${gapTopic}" (${gapType})

User's re-explanation:
${userExplanation}

Did they close this gap? Return JSON:
{
  "closed": true or false,
  "score_delta": integer 0-15 (how much they improved),
  "feedback": "One encouraging sentence — what they got right or what's still missing"
}`,
      },
    ],
    { system: REPORT_SYSTEM, json: !!process.env.OPENAI_API_KEY }
  );

  const parsed = parseJson(raw);
  return {
    closed: Boolean(parsed.closed),
    scoreDelta: Math.min(15, Math.max(0, Number(parsed.score_delta) || 0)),
    feedback: String(parsed.feedback || ''),
  };
}

function buildTranscript(session) {
  return session.rounds
    .map((r, i) => {
      const parts = [`Exchange ${i + 1}: ${r.userText}`];
      if (r.question) parts.push(`Q: ${r.question}`);
      if (r.answer) parts.push(`A: ${r.answer}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

async function previewQuestionFromText(documentText) {
  const raw = await chat([{ role: 'user', content: documentText }], {
    system: QUESTION_SYSTEM_PROMPT,
    json: !!process.env.OPENAI_API_KEY,
  });
  return normalizeAnalysis(parseJson(raw)).question;
}

async function extractFromDocument(text) {
  const [extracted, previewQuestion] = await Promise.all([
    extractFromNotes(text),
    previewQuestionFromText(text),
  ]);
  return { ...extracted, previewQuestion };
}

module.exports = {
  askGapQuestion,
  extractFromNotes,
  extractFromDocument,
  generateSessionReport,
  gradeProveIt,
  buildTranscript,
  getProvider,
};
