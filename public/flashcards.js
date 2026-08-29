export function renderFlashcards(container, gapMap, microLessons, analogies = []) {
  container.innerHTML = '';
  const shaky = (gapMap || []).filter((g) => g.status === 'shaky');
  if (!shaky.length) return;
  const lessons = Object.fromEntries((microLessons || []).map((l) => [l.gap_topic, l.lesson]));
  const analogiesMap = Object.fromEntries((analogies || []).map((a) => [a.gap_topic, a.analogy]));

  const grid = document.createElement('div');
  grid.className = 'flashcard-grid';

  for (const g of shaky) {
    const card = document.createElement('div');
    card.className = 'flashcard';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Flashcard: ${g.topic}. Click to flip.`);

    const analogy = analogiesMap[g.topic];
    card.innerHTML = `
      <div class="flashcard-inner">
        <div class="flashcard-front">
          <span class="fc-label">Gap</span>
          <strong>${esc(g.topic)}</strong>
          <span class="fc-hint">tap to reveal fix</span>
        </div>
        <div class="flashcard-back">
          <span class="fc-label">Micro-lesson</span>
          <p>${esc(lessons[g.topic] || 'Review this concept.')}</p>
          ${analogy ? `<span class="fc-label analogy">Analogy</span><p class="fc-analogy">${esc(analogy)}</p>` : ''}
        </div>
      </div>
    `;

    const flip = () => card.classList.toggle('flipped');
    card.addEventListener('click', flip);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flip();
      }
    });
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
