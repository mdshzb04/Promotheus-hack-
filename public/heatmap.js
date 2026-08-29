/** Highlight weak phrases in user explanation text */
export function buildHeatmapHtml(text, weakPhrases = []) {
  if (!text || !weakPhrases.length) return escapeHtml(text);

  let html = escapeHtml(text);
  const unique = [...new Set(weakPhrases.filter(Boolean))].sort((a, b) => b.length - a.length);

  for (const phrase of unique) {
    const escaped = escapeHtml(phrase);
    if (!escaped) continue;
    const re = new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark class="gap-heat">${m}</mark>`);
  }
  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderHeatmapPanel(container, text, analyses) {
  const weakPhrases = analyses
    .filter((a) => a?.gap_detected && a.weak_phrase)
    .map((a) => a.weak_phrase);

  if (!weakPhrases.length) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = `
    <span class="insight-label">Blind spot heatmap</span>
    <p class="heatmap-text">${buildHeatmapHtml(text, weakPhrases)}</p>
    <span class="heatmap-legend">Highlighted = where your explanation breaks down</span>
  `;
}
