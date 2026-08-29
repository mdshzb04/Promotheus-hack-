export function renderGapGraph(container, topic, gapMap) {
  container.innerHTML = '';
  if (!gapMap?.length) return;

  const w = container.clientWidth || 560;
  const h = 320;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.32;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'gap-graph-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Knowledge gap graph');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  `;
  svg.appendChild(defs);

  const nodes = [{ topic, status: 'center', x: cx, y: cy, r: 36 }];
  gapMap.forEach((g, i) => {
    const angle = (i / gapMap.length) * Math.PI * 2 - Math.PI / 2;
    nodes.push({
      ...g,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      r: 28,
    });
  });

  for (let i = 1; i < nodes.length; i++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', cx);
    line.setAttribute('y1', cy);
    line.setAttribute('x2', nodes[i].x);
    line.setAttribute('y2', nodes[i].y);
    line.setAttribute('class', `graph-edge ${nodes[i].status}`);
    svg.appendChild(line);
  }

  // ring edges between related sub-concepts
  for (let i = 1; i < nodes.length; i++) {
    const next = i + 1 < nodes.length ? i + 1 : 1;
    if (next === 1 && nodes.length <= 2) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', nodes[i].x);
    line.setAttribute('y1', nodes[i].y);
    line.setAttribute('x2', nodes[next].x);
    line.setAttribute('y2', nodes[next].y);
    line.setAttribute('class', 'graph-edge ring');
    svg.appendChild(line);
  }

  nodes.forEach((n, i) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'graph-node-group');
    g.style.animationDelay = `${i * 0.08}s`;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', n.x);
    circle.setAttribute('cy', n.y);
    circle.setAttribute('r', n.r);
    circle.setAttribute('class', `graph-node ${n.status}`);
    if (n.status === 'shaky') circle.setAttribute('filter', 'url(#glow)');

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', n.x);
    label.setAttribute('y', n.y + n.r + 16);
    label.setAttribute('class', 'graph-label');
    label.textContent = truncate(n.topic, n.status === 'center' ? 22 : 16);

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = n.status === 'center' ? `Topic: ${topic}` : `${n.topic} (${n.gap_type}) — ${n.status}`;

    g.appendChild(circle);
    g.appendChild(label);
    g.appendChild(title);
    svg.appendChild(g);
  });

  container.appendChild(svg);
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function animateScoreRing(svg, score) {
  const circle = svg.querySelector('.score-ring-progress');
  if (!circle) return;
  const r = circle.r.baseVal.value;
  const circumference = 2 * Math.PI * r;
  circle.style.strokeDasharray = `${circumference}`;
  circle.style.strokeDashoffset = `${circumference}`;
  requestAnimationFrame(() => {
    circle.style.strokeDashoffset = `${circumference * (1 - score / 100)}`;
  });
}

export function launchConfetti(container) {
  const colors = ['#4ade80', '#6ee7b7', '#818cf8', '#fbbf24', '#38bdf8'];
  for (let i = 0; i < 48; i++) {
    const p = document.createElement('div');
    p.className = 'confetti';
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.animationDuration = `${1.2 + Math.random()}s`;
    container.appendChild(p);
    setTimeout(() => p.remove(), 2500);
  }
}
