/**
 * Deterministic layout for the semantic stage. Coordinates are computed here,
 * never by the model. S06 ships a generic layered layout; S07 adds the four
 * relation-family templates on top of the same interface.
 */

const RELATION_WORDS = {
  causes: '导致',
  contrasts: '对比',
  part_of: '组成',
  converges_to: '汇入',
  sequence: '随后',
  conditional: '若',
};

const COMPARE_RELATIONS = new Set(['contrasts']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function nodeSize(label, { minWidth = 168, maxWidth = 300, charWidth = 15, lineHeight = 22 } = {}) {
  const text = String(label || '');
  const chars = [...text].length;
  const width = clamp(minWidth + Math.max(0, Math.min(chars, 24)) * 6, minWidth, maxWidth);
  const perLine = Math.max(8, Math.floor((width - 32) / charWidth));
  const lines = Math.max(1, Math.ceil(chars / perLine));
  const height = Math.max(58, 30 + lines * lineHeight);
  return { width: Math.round(width), height: Math.round(height), lines };
}

/** Rank nodes by longest path over directed relations; compare edges do not constrain ranks. */
function computeRanks(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (COMPARE_RELATIONS.has(edge.relation)) continue;
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }
  const rank = new Map();
  const visiting = new Set();
  const visit = (id, depth = 0) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id) || depth > nodes.length + 1) return 0;
    visiting.add(id);
    let r = 0;
    for (const from of incoming.get(id) || []) r = Math.max(r, visit(from, depth + 1) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const node of nodes) visit(node.id);
  return rank;
}

function assignColumns(nodes, edges, ranks) {
  const columns = new Map();
  let maxRank = 0;
  for (const node of nodes) {
    const r = ranks.get(node.id) ?? 0;
    maxRank = Math.max(maxRank, r);
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(node);
  }
  return { columns, maxRank };
}

/** Place nodes left-to-right by rank, top-to-bottom inside a rank. */
export function layoutLayered(nodes, edges, { width = 1200, height = 680, padding = 56 } = {}) {
  if (!nodes.length) return { nodes: [], edges: [], width, height };
  const ranks = computeRanks(nodes, edges);
  const { columns, maxRank } = assignColumns(nodes, edges, ranks);
  const gutter = 80;
  const colCount = maxRank + 1;
  const colWidth = Math.max(180, (width - padding * 2 - gutter * (colCount - 1)) / colCount);
  const positions = new Map();
  for (const [rank, list] of columns) {
    list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id)));
    const sizes = list.map((n) => nodeSize(n.label));
    const totalHeight = sizes.reduce((sum, s) => sum + s.height, 0) + Math.max(0, list.length - 1) * 26;
    let y = Math.max(padding, (height - totalHeight) / 2);
    list.forEach((node, i) => {
      const size = sizes[i];
      const x = padding + rank * (colWidth + gutter) + (colWidth - size.width) / 2;
      positions.set(node.id, { x, y, width: size.width, height: size.height, rank });
      y += size.height + 26;
    });
  }
  return {
    ...finishLayout(nodes, edges, positions, { width, height, kind: 'layered' }),
    width,
    height,
  };
}

/** Neutral text scene: a readable column, no fabricated edges. */
export function layoutText(nodes, edges = [], { width = 1200, height = 680, padding = 80 } = {}) {
  const positions = new Map();
  const maxWidth = Math.min(760, width - padding * 2);
  const left = Math.round((width - maxWidth) / 2);
  let y = padding;
  for (const node of nodes) {
    const size = nodeSize(node.label, { minWidth: Math.min(320, maxWidth), maxWidth });
    positions.set(node.id, { x: left, y, width: size.width, height: size.height });
    y += size.height + 24;
  }
  return finishLayout(nodes, edges, positions, { width, height, kind: 'text' });
}

function finishLayout(nodes, edges, positions, { width, height, kind }) {
  const placedNodes = nodes.map((node) => ({ id: node.id, ...positions.get(node.id) }));
  const byId = new Map(placedNodes.map((n) => [n.id, n]));
  const placedEdges = [];
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const overlap = !(from.x + from.width <= to.x || to.x + to.width <= from.x);
    const sameColumn = Math.abs(from.x - to.x) < 4 || overlap;
    const backRaw = !sameColumn && to.x < from.x;
    let fromX;
    let fromY;
    let toX;
    let toY;
    let c1x;
    let c1y;
    let c2x;
    let c2y;
    let dir = 'forward';
    if (sameColumn) {
      dir = 'vertical';
      const down = to.y >= from.y;
      fromX = from.x + from.width / 2;
      toX = to.x + to.width / 2;
      fromY = down ? from.y + from.height : from.y;
      toY = down ? to.y : to.y + to.height;
      c1x = fromX + Math.min(64, Math.abs(toX - fromX) / 2 + 40);
      c1y = fromY + (down ? 22 : -22);
      c2x = toX - Math.min(64, Math.abs(toX - fromX) / 2 + 40);
      c2y = toY - (down ? 22 : -22);
    } else {
      fromX = from.x + from.width;
      fromY = from.y + from.height / 2;
      toX = to.x;
      toY = to.y + to.height / 2;
      const dx = Math.abs(toX - fromX);
      const bend = Math.min(120, Math.max(10, dx * 0.45));
      const rankSpan = Number.isFinite(from.rank) && Number.isFinite(to.rank) ? to.rank - from.rank : 0;
      c1x = fromX + bend;
      c1y = fromY;
      c2x = toX - bend;
      c2y = toY;
      if (backRaw) {
        dir = 'back';
        const reach = Math.min(90, dx * 0.3);
        c1x = fromX + reach;
        c1y = fromY - 120;
        c2x = toX - reach;
        c2y = toY - 120;
      } else if (rankSpan > 1) {
        // Long forward edge: dip below the columns it skips instead of cutting through them.
        dir = 'forward-long';
        const midY = (fromY + toY) / 2;
        const below = height - midY - 70;
        const dip = below >= 90 ? Math.min(160, below) : -Math.min(160, midY - 60);
        const reach = Math.min(120, dx * 0.35);
        c1x = fromX + reach;
        c1y = fromY + dip;
        c2x = toX - reach;
        c2y = toY + dip;
      }
    }
    const path = `M ${fromX} ${fromY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${toX} ${toY}`;
    let lx = (fromX + 3 * c1x + 3 * c2x + toX) / 8;
    let ly = (fromY + 3 * c1y + 3 * c2y + toY) / 8 - 10;
    if (sameColumn) {
      // Stacked cards leave only a thin gap: put the relation label beside the
      // connector rather than squeezing it between the cards.
      lx = Math.max(from.x + from.width, to.x + to.width) + 16;
      ly = (fromY + toY) / 2 + 4;
    } else {
      for (const node of placedNodes) {
        if (lx > node.x - 10 && lx < node.x + node.width + 10 && ly > node.y - 12 && ly < node.y + node.height + 12) {
          ly = node.y + node.height + 18;
          break;
        }
      }
    }
    lx = Math.min(Math.max(lx, 30), width - 30);
    ly = Math.min(Math.max(ly, 22), height - 12);
    placedEdges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      dir,
      x1: fromX,
      y1: fromY,
      x2: toX,
      y2: toY,
      lx,
      ly,
      cx: (fromX + toX) / 2,
      cy: (fromY + toY) / 2,
      path,
    });
  }
  return { nodes: placedNodes, edges: placedEdges, width, height, kind };
}

/** Generic entry point used by the renderer. */
export function layoutScene({ scene, nodes, edges, width = 1200, height = 680 } = {}) {
  const visibleNodes = (nodes || []).filter((n) => n.state !== 'retracted');
  const visibleEdges = (edges || []).filter(
    (e) => e.state !== 'retracted' && visibleNodes.some((n) => n.id === e.from) && visibleNodes.some((n) => n.id === e.to)
  );
  const family = scene ? scene.family : 'text';
  if (family === 'text') {
    return { ...layoutText(visibleNodes, visibleEdges, { width, height }), family };
  }
  if (!visibleEdges.length) {
    return { ...layoutText(visibleNodes, [], { width, height }), family };
  }
  return { ...layoutLayered(visibleNodes, visibleEdges, { width, height }), family };
}

export function relationWord(relation, label) {
  if (label && String(label).trim()) return String(label).trim();
  return RELATION_WORDS[relation] || '';
}

export { RELATION_WORDS, COMPARE_RELATIONS };
