/** SVG sparkline of mastery score over the session */
export function renderJourney(container, scoreHistory = []) {
  container.innerHTML = '';
  if (scoreHistory.length < 2) return;

  const w = 280;
  const h = 56;
  const pad = 4;
  const scores = scoreHistory.map((s) => s.score);
  const min = Math.max(0, Math.min(...scores) - 10);
  const max = Math.min(100, Math.max(...scores) + 10);
  const range = max - min || 1;

  const points = scores.map((score, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (score - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });

  const last = scores.at(-1);
  const first = scores[0];
  const delta = last - first;
  const deltaClass = delta >= 0 ? 'up' : 'down';
  const deltaSign = delta >= 0 ? '+' : '';

  container.innerHTML = `
    <div class="journey-header">
      <span class="insight-label">Mastery journey</span>
      <span class="journey-delta ${deltaClass}">${deltaSign}${delta}%</span>
    </div>
    <svg class="journey-svg" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline class="journey-line" points="${points.join(' ')}" />
      ${scores.map((score, i) => {
        const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
        const y = pad + (1 - (score - min) / range) * (h - pad * 2);
        const hot = scoreHistory[i].gapDetected;
        return `<circle cx="${x}" cy="${y}" r="3.5" class="journey-dot ${hot ? 'gap' : 'solid'}" />`;
      }).join('')}
    </svg>
  `;
}
