const canvas = document.querySelector('#scene');
const ctx = canvas.getContext('2d');
const brainName = document.querySelector('#brain-name');
const stats = document.querySelector('#stats');
const categoriesEl = document.querySelector('#categories');
const selectedEl = document.querySelector('#selected');
const search = document.querySelector('#search');
const visibleCount = document.querySelector('#visible-count');
const cinema = document.querySelector('#cinema');
const replay = document.querySelector('#replay');

const palette = ['#7aa2ff', '#d083ff', '#64e3c1', '#ffb86b', '#ff7d9a', '#78d7ff', '#b6df72', '#ffd66b', '#9ea7ff', '#ff9e74', '#6fe0ff', '#c993ff'];

let graph;
let yaw = 0.45;
let pitch = -0.15;
let zoom = 1;
let dragging = false;
let lastX = 0;
let lastY = 0;
let selectedId = null;
let hitPoints = [];
let query = '';
let replayStart = null;
let replayActive = false;
let replayFraction = 1;
const enabled = new Set();

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function categoryColor(id) {
  const index = graph.categories.findIndex(c => c.id === id);
  return palette[(index < 0 ? 0 : index) % palette.length];
}

function seededSphere(id, i, total) {
  const n = Math.max(total, 2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / (n - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const jitter = ((hash(id) % 1000) / 1000 - 0.5) * 0.08;
  const theta = golden * i + jitter;
  return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius };
}

function rotate(p) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const y1 = p.y;
  return {
    x: x1,
    y: y1 * cp - z1 * sp,
    z: y1 * sp + z1 * cp
  };
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function filteredNodes() {
  const q = query.toLowerCase();
  return graph.nodes.filter(n => {
    if (!enabled.has(n.categoryId)) return false;
    if (!q) return true;
    return n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || n.categoryLabel.toLowerCase().includes(q);
  });
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const nodesAll = filteredNodes();
  const maxReplay = replayActive ? Math.max(1, Math.ceil(nodesAll.length * replayFraction)) : nodesAll.length;
  const nodes = nodesAll.slice(0, maxReplay);
  visibleCount.textContent = String(nodes.length);

  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const base = Math.min(rect.width, rect.height) * 0.34 * zoom;
  const idSet = new Set(nodes.map(n => n.id));
  const positions = new Map();

  graph.nodes.forEach((node, i) => {
    const p = rotate(node._p || (node._p = seededSphere(node.id, i, graph.nodes.length)));
    const depth = (p.z + 1) / 2;
    const perspective = 0.72 + depth * 0.38;
    positions.set(node.id, {
      x: cx + p.x * base * perspective,
      y: cy + p.y * base * perspective,
      z: p.z,
      depth,
      perspective
    });
  });

  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, base * 0.22);
  glow.addColorStop(0, 'rgba(194,218,255,.95)');
  glow.addColorStop(.12, 'rgba(92,146,255,.55)');
  glow.addColorStop(.45, 'rgba(68,112,255,.10)');
  glow.addColorStop(1, 'rgba(68,112,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, base * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 1;
  for (const edge of graph.edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const alpha = 0.08 + Math.min(a.depth, b.depth) * 0.18;
    ctx.strokeStyle = `rgba(148,173,220,${alpha})`;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  hitPoints = [];
  const sorted = nodes.slice().sort((a, b) => positions.get(a.id).z - positions.get(b.id).z);
  for (const node of sorted) {
    const p = positions.get(node.id);
    const color = categoryColor(node.categoryId);
    const isSelected = node.id === selectedId;
    const radius = (2.2 + p.depth * 2.3) * Math.max(.75, zoom) + (isSelected ? 2 : 0);
    const alpha = 0.35 + p.depth * 0.65;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur = isSelected ? 18 : 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (isSelected || (query && radius > 2)) {
      ctx.fillStyle = 'rgba(239,245,255,.9)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(node.title.slice(0, 50), p.x + radius + 5, p.y - 4);
    }

    hitPoints.push({ node, x: p.x, y: p.y, r: Math.max(8, radius + 5), z: p.z });
  }

  if (replayActive && replayStart) {
    const elapsed = performance.now() - replayStart;
    replayFraction = Math.min(1, elapsed / 12000);
    if (replayFraction >= 1) {
      replayActive = false;
      replay.textContent = 'Play demo';
    }
  }

  requestAnimationFrame(render);
}

function renderStats() {
  stats.innerHTML = [
    ['Notes', graph.counts.nodes],
    ['Links', graph.counts.edges],
    ['Sources', graph.counts.categories]
  ].map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
}

function renderCategories() {
  categoriesEl.innerHTML = '';
  for (const cat of graph.categories) {
    const button = document.createElement('button');
    button.className = 'category';
    button.dataset.id = cat.id;
    const count = graph.nodes.filter(n => n.categoryId === cat.id).length;
    button.innerHTML = `<span class="dot" style="--dot:${categoryColor(cat.id)}"></span><span>${cat.label}</span><span class="muted" style="margin-left:auto">${count}</span>`;
    button.addEventListener('click', () => {
      if (enabled.has(cat.id)) enabled.delete(cat.id); else enabled.add(cat.id);
      button.classList.toggle('off', !enabled.has(cat.id));
    });
    categoriesEl.appendChild(button);
  }
}

function selectNode(node) {
  selectedId = node?.id || null;
  if (!node) {
    selectedEl.innerHTML = '<div class="muted">Select a node to inspect it.</div>';
    return;
  }
  selectedEl.innerHTML = `
    <h3>${escapeHtml(node.title)}</h3>
    <div>${escapeHtml(node.categoryLabel)}</div>
    <div class="path">${escapeHtml(node.path)}</div>
    <div class="muted" style="margin-top:8px">${Math.round(node.size / 1024 * 10) / 10} KB source</div>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

canvas.addEventListener('pointerdown', e => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!dragging) return;
  yaw += (e.clientX - lastX) * 0.008;
  pitch += (e.clientY - lastY) * 0.008;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener('pointerup', e => {
  const moved = Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
  dragging = false;
  canvas.classList.remove('dragging');
  if (moved < 6) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const candidates = hitPoints.filter(p => Math.hypot(p.x - x, p.y - y) <= p.r).sort((a, b) => b.z - a.z);
    selectNode(candidates[0]?.node || null);
  }
});
canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('dragging'); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoom *= e.deltaY > 0 ? 0.92 : 1.08;
  zoom = Math.max(0.45, Math.min(2.25, zoom));
}, { passive: false });

search.addEventListener('input', () => { query = search.value.trim(); });
cinema.addEventListener('click', () => {
  document.body.classList.toggle('cinema');
  cinema.textContent = document.body.classList.contains('cinema') ? 'Exit Cinema' : 'Cinema';
  setTimeout(resize, 20);
});
replay.addEventListener('click', () => {
  replayActive = true;
  replayStart = performance.now();
  replayFraction = 0;
  replay.textContent = 'Replaying...';
});
window.addEventListener('resize', resize);

async function init() {
  const res = await fetch('graph.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('graph.json not found. Run node build.mjs first.');
  graph = await res.json();
  brainName.textContent = graph.name || 'AI-Verse Brain';
  document.title = `${graph.name || 'AI-Verse Brain'} - 3D Brain`;
  for (const cat of graph.categories) enabled.add(cat.id);
  renderStats();
  renderCategories();
  resize();
  requestAnimationFrame(render);
}

init().catch(err => {
  selectedEl.innerHTML = `<div class="path">${escapeHtml(err.message)}</div>`;
  console.error(err);
});
