const GRADES = [
  [90, 'A', 'Crystal clear — you could teach this'],
  [75, 'B', 'Strong grasp with minor holes'],
  [60, 'C', 'Skeleton there — flesh out the gaps'],
  [45, 'D', 'Surface level — dig deeper'],
  [0, 'F', 'Foundational gaps — start with basics'],
];

function computeMastery(gapMap, rounds) {
  if (!gapMap?.length) {
    return { score: 0, grade: 'F', verdict: GRADES.at(-1)[2], solid: 0, shaky: 0, total: 0 };
  }

  const solid = gapMap.filter((g) => g.status === 'solid').length;
  const shaky = gapMap.filter((g) => g.status === 'shaky').length;
  const total = gapMap.length;

  const base = Math.round((solid / total) * 100);
  const depthBonus = Math.min(15, rounds.filter((r) => r.answer && r.answer.length > 80).length * 5);
  const score = Math.min(100, Math.max(0, base + depthBonus));

  const gradeRow = GRADES.find(([min]) => score >= min) || GRADES.at(-1);
  return { score, grade: gradeRow[1], verdict: gradeRow[2], solid, shaky, total };
}

/** Live score during session — uses latest classification per sub-concept */
function computeLiveMastery(session, gapMap) {
  const analyses = session.rounds.filter((r) => r.analysis);
  if (!analyses.length) {
    return { score: 72, grade: 'C', verdict: 'Explain more to measure…', solid: 0, shaky: 0, total: 0, gapPercent: 28 };
  }

  const m = computeMastery(gapMap, session.rounds);
  const gapPercent = m.total ? Math.round((m.shaky / m.total) * 100) : 0;
  return { ...m, gapPercent };
}

function weakestGap(gapMap) {
  return gapMap?.find((g) => g.status === 'shaky') || null;
}

module.exports = { computeMastery, computeLiveMastery, weakestGap, GRADES };
