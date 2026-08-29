const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeMastery, computeLiveMastery } = require('../lib/scoring');
const {
  createSession,
  recordAnalysis,
  recordAnswer,
  startNextRound,
  planNextStep,
  applyRoutingState,
  buildGapMap,
  finalizeSession,
  buildMarkdownReport,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
} = require('../lib/session');

describe('scoring', () => {
  it('computes mastery from gap map', () => {
    const m = computeMastery(
      [
        { status: 'solid', topic: 'a' },
        { status: 'shaky', topic: 'b' },
      ],
      [{ answer: 'long enough answer here to get depth bonus points' }]
    );
    assert.ok(m.score >= 50 && m.score <= 100);
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(m.grade));
  });

  it('computes live mastery mid-session', () => {
    const s = createSession('Test', 'Initial explanation here.');
    recordAnalysis(s, {
      question: 'Q?',
      gap_detected: true,
      gap_type: 'mechanism',
      gap_topic: 'core',
      severity: 'moderate',
    });
    const live = computeLiveMastery(s, buildGapMap(s));
    assert.ok(live.score >= 0);
    assert.ok(typeof live.gapPercent === 'number');
  });
});

describe('adaptive routing', () => {
  it('deepens on severe gaps', () => {
    const s = createSession('T', 'Explain things.');
    recordAnalysis(s, {
      question: 'Why?',
      gap_detected: true,
      gap_type: 'causal',
      gap_topic: 'mechanism',
      severity: 'severe',
    });
    recordAnswer(s, 'Because.');
    const step = planNextStep(s);
    assert.equal(step.complete, false);
    assert.equal(step.routing.mode, 'deepen');
    assert.equal(step.routing.focus, 'mechanism');
  });

  it('completes after enough solid exchanges', () => {
    const s = createSession('T', 'Initial long enough explanation.');
    for (let i = 0; i < MIN_QUESTIONS; i++) {
      recordAnalysis(s, {
        question: `Q${i}?`,
        gap_detected: false,
        gap_type: 'definition',
        gap_topic: `concept-${i}`,
        severity: 'none',
      });
      if (i < MIN_QUESTIONS - 1) {
        recordAnswer(s, 'Solid answer here.');
        startNextRound(s, 'Solid answer here.');
      } else {
        recordAnswer(s, 'Final solid answer.');
      }
    }
    const step = planNextStep(s);
    assert.equal(step.complete, true);
  });
});

describe('session store', () => {
  it('finalizes with report and markdown', () => {
    const s = createSession('Test', 'Initial');
    finalizeSession(s, {
      microLessons: [{ gap_topic: 'x', lesson: 'y' }],
      analogies: [{ gap_topic: 'x', analogy: 'Like a pipe.' }],
      expertSnapshot: 'Expert line.',
      coachNote: 'Keep going.',
    });
    assert.equal(s.complete, true);
    assert.equal(s.mastery.grade.length, 1);
    assert.match(buildMarkdownReport(s), /Expert Snapshot/);
  });
});
