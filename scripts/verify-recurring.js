#!/usr/bin/env node
/** Seed 4 demo sessions + verify /api/insights (no OpenAI calls). */
const fs = require('fs');
const path = require('path');
const { appendSession, computeInsights, HISTORY_FILE } = require('../lib/gap-history');

const SESSIONS = [
  {
    id: 'demo001',
    topic: 'Photosynthesis light and dark reactions',
    rounds: [
      { analysis: { gap_type: 'causal_link', gap_detected: true } },
      { analysis: { gap_type: 'mechanism', gap_detected: true } },
    ],
  },
  {
    id: 'demo002',
    topic: 'How vaccines train the immune system',
    rounds: [
      { analysis: { gap_type: 'causal_link', gap_detected: true } },
      { analysis: { gap_type: 'definition', gap_detected: false } },
    ],
  },
  {
    id: 'demo003',
    topic: 'Why the sky is blue (Rayleigh scattering)',
    rounds: [
      { analysis: { gap_type: 'mechanism', gap_detected: true } },
      { analysis: { gap_type: 'causal_link', gap_detected: true } },
    ],
  },
  {
    id: 'demo004',
    topic: 'Binary search algorithm',
    rounds: [
      { analysis: { gap_type: 'definition', gap_detected: true } },
      { analysis: { gap_type: 'scope', gap_detected: true } },
    ],
  },
];

function main() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, '[]');

  for (const s of SESSIONS) appendSession(s);

  const insights = computeInsights();
  console.log('✓ Seeded', SESSIONS.length, 'sessions →', HISTORY_FILE);
  console.log('✓ Insights:', JSON.stringify(insights, null, 2));

  if (!insights.showInsights) {
    console.error('✗ Expected showInsights:true after 4 sessions');
    process.exit(1);
  }
  if (insights.patterns[0]?.type !== 'causal_link') {
    console.error('✗ Expected causal_link as top pattern');
    process.exit(1);
  }

  console.log('\n→ Open http://localhost:3000, complete any session, report shows recurring card.');
}

main();
