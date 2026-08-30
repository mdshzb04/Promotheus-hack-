const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { gapTypesFromSession, computeInsights } = require('../lib/gap-history');

describe('gap-history', () => {
  it('extracts gap types from all analyzed rounds', () => {
    const types = gapTypesFromSession({
      rounds: [
        { analysis: { gap_detected: true, gap_type: 'mechanism' } },
        { analysis: { gap_detected: false, gap_type: 'definition' } },
        { analysis: { gap_detected: true, gap_type: 'causal_link' } },
      ],
    });
    assert.deepEqual(types, ['mechanism', 'definition', 'causal_link']);
  });

  it('hides insights before 2 sessions', () => {
    const r = computeInsights([
      { sessionId: 'a', topic: 'T', gapTypes: ['mechanism'] },
    ]);
    assert.equal(r.showInsights, false);
  });

  it('surfaces top recurring pattern across sessions', () => {
    const r = computeInsights([
      { sessionId: 'a', topic: 'A', gapTypes: ['causal_link', 'mechanism'] },
      { sessionId: 'b', topic: 'B', gapTypes: ['causal_link'] },
      { sessionId: 'c', topic: 'C', gapTypes: ['definition'] },
      { sessionId: 'd', topic: 'D', gapTypes: ['causal_link', 'definition'] },
    ]);
    assert.equal(r.showInsights, true);
    assert.equal(r.sessionsAnalyzed, 4);
    assert.equal(r.patterns[0].type, 'causal_link');
    assert.equal(r.patterns[0].sessionCount, 3);
    assert.match(r.message, /causal/i);
  });
});
