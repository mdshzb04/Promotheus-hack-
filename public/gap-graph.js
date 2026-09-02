const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_H = 13;

const STATUS_TEXT = {
  center: 'Topic',
  solid: 'Solid',
  shaky: 'Shaky',
  gap: 'Specific gap',
};

function statusText(status) {
  return STATUS_TEXT[status] || 'Not yet explored';
}

/** Word-wrap a label into short lines; last line ellipsized if it overflows. */
export function wrapLabel(s, maxChars = 18, maxLines = 3) {
  const words = String(s ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [''];
  for (const word of words) {
    const chunks = word.length > maxChars ? word.match(new RegExp(`.{1,${maxChars}}`, 'g')) : [word];
    for (const chunk of chunks) {
      const last = lines[lines.length - 1];
      if (!last) lines[lines.length - 1] = chunk;
      else if (`${last} ${chunk}`.length <= maxChars) lines[lines.length - 1] = `${last} ${chunk}`;
      else lines.push(chunk);
    }
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxChars - 1) + '…';
    return kept;
  }
  return lines;
}

function makeNode(id, label, status) {
  const lines = wrapLabel(label);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return {
    id,
    label: String(label ?? ''),
    status,
    lines,
    w: Math.max(64, Math.round(longest * 6.4) + 22),
    h: lines.length * LINE_H + 16,
    x: 0,
    y: 0,
    parent: null,
    gapType: null,
    concept: null,
  };
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// Wide layout: root topic on top, sub-concepts in a row, specific gaps below.
// ponytail: gap nodes clamp to parent x and can overlap when two adjacent
// shaky sub-concepts sit close together; fine for the ≤6 nodes a session
// produces. Upgrade path: collision pass shifting siblings apart.
function layoutTree(nodes, width) {
  const root = nodes[0];
  const subs = nodes.filter((n) => n.parent === root);
  root.x = width / 2;
  root.y = 14 + root.h / 2;
  const subTop = root.y + root.h / 2 + 46;
  let subBottom = subTop;
  subs.forEach((s, i) => {
    s.x = clamp((width * (i + 0.5)) / subs.length, s.w / 2 + 6, width - s.w / 2 - 6);
    s.y = subTop + s.h / 2;
    subBottom = Math.max(subBottom, s.y + s.h / 2);
  });
  let bottom = subBottom;
  const gapTop = subBottom + 44;
  for (const n of nodes) {
    if (!n.parent || n.parent === root) continue;
    n.x = clamp(n.parent.x, n.w / 2 + 6, width - n.w / 2 - 6);
    n.y = gapTop + n.h / 2;
    bottom = Math.max(bottom, n.y + n.h / 2);
  }
  return bottom + 16;
}

// Narrow layout: vertical tree, children indented under their parent.
function layoutVertical(nodes, width) {
  const root = nodes[0];
  let y = 12;
  for (const n of nodes) {
    const depth = !n.parent ? 0 : n.parent === root ? 1 : 2;
    const left = 10 + depth * 22;
    n.w = Math.max(64, Math.min(n.w, width - left - 12));
    n.x = left + n.w / 2;
    n.y = y + n.h / 2;
    y += n.h + 16;
  }
  return y;
}

/**
 * Pure graph model: root topic → sub-concepts (gapMap items) → specific gaps
 * (each shaky item's gap_type). No relationships invented beyond that hierarchy.
 */
export function buildGraphModel(topic, gapMap, width) {
  const items = gapMap || [];
  const root = makeNode('root', topic || 'Topic', 'center');
  const nodes = [root];
  items.forEach((g, i) => {
    const status = g.status === 'solid' || g.status === 'shaky' ? g.status : 'unexplored';
    const sub = makeNode(`sub-${i}`, g.topic, status);
    sub.parent = root;
    sub.gapType = g.gap_type || null;
    sub.concept = g.topic;
    nodes.push(sub);
    if (status === 'shaky' && g.gap_type && g.gap_type !== 'none') {
      const gapNode = makeNode(`gap-${i}`, g.gap_type, 'gap');
      gapNode.parent = sub;
      gapNode.concept = g.topic;
      nodes.push(gapNode);
    }
  });
  const narrow = width < 460 || (items.length > 0 && width / items.length < 120);
  const height = narrow ? layoutVertical(nodes, width) : layoutTree(nodes, width);
  return { nodes, width, height, narrow };
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function edgeEl(n, narrow) {
  if (narrow) {
    const px = n.parent.x - n.parent.w / 2 + 12;
    const points = `${px},${n.parent.y + n.parent.h / 2} ${px},${n.y} ${n.x - n.w / 2},${n.y}`;
    return svgEl('polyline', { points, fill: 'none', class: `graph-edge ${n.status}` });
  }
  return svgEl('line', {
    x1: n.parent.x,
    y1: n.parent.y + n.parent.h / 2,
    x2: n.x,
    y2: n.y - n.h / 2,
    class: `graph-edge ${n.status}`,
  });
}

function showDetail(detail, n, opts) {
  detail.classList.remove('hidden');
  detail.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `graph-detail-badge ${n.status}`;
  badge.textContent = statusText(n.status);
  const name = document.createElement('strong');
  name.className = 'graph-detail-name';
  name.textContent = n.label;
  detail.append(badge, name);
  if (n.gapType && n.gapType !== 'none') {
    const type = document.createElement('span');
    type.className = 'graph-detail-type';
    type.textContent = `Gap type: ${n.gapType}`;
    detail.appendChild(type);
  }
  const card = n.concept ? opts.getFlashcard?.(n.concept) : null;
  if (card) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-detail-link';
    btn.textContent = 'View flashcard →';
    btn.addEventListener('click', () => {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.focus({ preventScroll: true });
    });
    detail.appendChild(btn);
  }
}

function nodeEl(n, i, svg, detail, opts) {
  const g = svgEl('g', {
    class: 'graph-node-group',
    tabindex: '0',
    role: 'button',
    'aria-label': `${n.label} — ${statusText(n.status)}`,
  });
  g.style.animationDelay = `${i * 0.06}s`;
  g.appendChild(
    svgEl('rect', {
      x: n.x - n.w / 2,
      y: n.y - n.h / 2,
      width: n.w,
      height: n.h,
      rx: 9,
      class: `graph-node ${n.status}`,
    })
  );
  const text = svgEl('text', { class: 'graph-label' });
  const firstY = n.y - ((n.lines.length - 1) * LINE_H) / 2 + 3.5;
  n.lines.forEach((line, li) => {
    const tspan = svgEl('tspan', { x: n.x, y: firstY + li * LINE_H });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  g.appendChild(text);
  const title = svgEl('title');
  title.textContent = `${n.label} — ${statusText(n.status)}`;
  g.appendChild(title);

  const select = () => {
    svg.querySelectorAll('.graph-node-group.selected').forEach((s) => s.classList.remove('selected'));
    g.classList.add('selected');
    showDetail(detail, n, opts);
  };
  g.addEventListener('click', select);
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  });
  return g;
}

export function renderGapGraph(container, topic, gapMap, opts = {}) {
  container.innerHTML = '';
  if (!topic && !gapMap?.length) return;

  const width = container.clientWidth || 560;
  const model = buildGraphModel(topic, gapMap, width);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${model.height}`,
    class: 'gap-graph-svg',
    role: 'img',
    'aria-label': 'Knowledge graph: topic, sub-concepts, and specific gaps',
  });

  const detail = document.createElement('div');
  detail.className = 'graph-detail hidden';

  for (const n of model.nodes) if (n.parent) svg.appendChild(edgeEl(n, model.narrow));
  model.nodes.forEach((n, i) => svg.appendChild(nodeEl(n, i, svg, detail, opts)));

  container.appendChild(svg);
  container.appendChild(detail);
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
