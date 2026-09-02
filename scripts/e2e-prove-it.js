#!/usr/bin/env node
/** Manual E2E: session → shaky gap → prove-it → gap map + share consistency */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const TOPIC = 'Why photosynthesis needs light and dark reactions';
const EXPLANATION =
  "Plants use sunlight in the light reactions to make ATP and NADPH, then the Calvin cycle uses those to fix CO₂ into sugar. The light reactions happen in thylakoid membranes. I'm less sure how the Calvin cycle actually uses the ATP step by step.";

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
  return data;
}

function summarize(session) {
  const gaps = (session.gapMap || []).map((g) => `${g.topic}:${g.status}`).join(', ');
  const m = session.mastery || {};
  return {
    score: m.score,
    grade: m.grade,
    solid: m.solid,
    shaky: m.shaky,
    gaps,
    proveIt: session.proveIt?.topic || null,
    proveItResult: session.proveItResult?.closed ?? null,
  };
}

async function main() {
  console.log('1. Starting session…');
  let data = await api('/api/start', { topic: TOPIC, explanation: EXPLANATION });
  let sessionId = data.session.id;
  console.log('   Q1:', data.question?.slice(0, 80) + '…');
  console.log('   gap:', data.analysis?.gap_topic, data.analysis?.gap_detected ? 'shaky' : 'solid');

  const answers = [
    'The Calvin cycle uses ATP to phosphorylate 3-PGA into 1,3-bisphosphoglycerate, then NADPH reduces it to G3P which builds glucose.',
    'Light reactions split water via photolysis in photosystem II, pump protons for chemiosmosis, and photosystem I reduces NADP+ to NADPH while making ATP.',
    'Both stages are coupled because Calvin cycle cannot run without ATP and NADPH from the thylakoids — that is why both are required.',
  ];

  let answerIdx = 0;
  while (!data.complete && answerIdx < answers.length) {
    console.log(`2. Answering round ${answerIdx + 1}…`);
    data = await api('/api/answer', { sessionId, answer: answers[answerIdx++] });
    if (!data.complete) {
      console.log('   Q:', data.question?.slice(0, 80) + '…');
      console.log('   gap:', data.analysis?.gap_topic, data.analysis?.gap_detected ? 'shaky' : 'solid');
    }
  }

  if (!data.complete) throw new Error('Session did not complete in time');

  const before = summarize(data.session);
  console.log('\n3. Session complete — BEFORE prove-it:');
  console.log(JSON.stringify(before, null, 2));

  const shaky = (data.session.gapMap || []).filter((g) => g.status === 'shaky');
  if (!shaky.length) throw new Error('No shaky gap to test prove-it against');
  if (!data.session.proveIt) throw new Error('No prove-it challenge offered');

  const proveTopic = data.session.proveIt.topic;
  const proveExplanation =
    `The ${proveTopic} works like this: RuBisCO fixes CO₂ onto RuBP forming unstable 6-carbon intermediates that split into 3-PGA. ` +
    'ATP phosphorylates 3-PGA to 1,3-BPG, NADPH reduces it to G3P, and G3P regenerates RuBP so the cycle continues — ' +
    'that is the mechanistic link between light-reaction products and sugar synthesis.';

  console.log(`\n4. Submitting prove-it for "${proveTopic}"…`);
  const prove = await api('/api/prove-it', { sessionId, explanation: proveExplanation });
  console.log('   closed:', prove.result?.closed, '| feedback:', prove.result?.feedback?.slice(0, 100));

  const after = summarize(prove.session);
  console.log('\n5. AFTER prove-it (in-app session):');
  console.log(JSON.stringify(after, null, 2));

  const shareRes = await fetch(`${BASE}/api/session/${sessionId}`);
  const shareData = await shareRes.json();
  const share = summarize(shareData.session);
  console.log('\n6. Share API (/api/session/:id):');
  console.log(JSON.stringify(share, null, 2));

  const checks = [];
  const target = prove.session.gapMap?.find((g) => g.topic === proveTopic);
  checks.push(['Gap flipped to solid', target?.status === 'solid']);
  checks.push(['Mastery score improved', after.score > before.score]);
  checks.push(['Grade updated from before', after.grade !== before.grade || after.score > before.score]);
  checks.push(['Share score matches in-app', share.score === after.score]);
  checks.push(['Share gap status matches', share.gaps === after.gaps]);

  console.log('\n=== CHECKLIST ===');
  let pass = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✔' : '✖'} ${label}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} passed`);
  if (pass < checks.length) process.exit(1);
}

main().catch((err) => {
  console.error('E2E failed:', err.message);
  process.exit(1);
});
