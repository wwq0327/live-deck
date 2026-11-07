/**
 * Relation-aware layouts. Each family gets a small, stable template:
 *   cause       — left-to-right chain with directed arrows
 *   compare     — paired columns around a shared row, no causal arrow
 *   composition — one container (stacked parts) or a part→whole chain
 *   convergence — sources on the left fan into the target on the right
 *   text        — neutral single column, edges kept but not forced into causality
 *
 * Layout only chooses geometry. It never drops nodes: capacity pressure is
 * reported in `capacity` so the presenter/director can continue in a new scene.
 */

export const RELATION_WORDS = {
  causes: '导致',
  contrasts: '对比',
  part_of: '组成',
  converges_to: '汇入',
  sequence: '随后',
  conditional: '若',
};

export const COMPARE_RELATIONS = new Set(['contrasts']);
const MAX_VISIBLE_NODES = 6;
const MAX_VISIBLE_EDGES = 8;

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

function placeNode(id, x, y, label, extra = {}) {
  const size = nodeSize(label);
  return { id, x: Math.round(x), y: Math.round(y), width: size.width, height: size.height, ...extra };
}

function relationLabel(edge, fallback = true) {
  if (edge.label && String(edge.label).trim()) return String(edge.label).trim();
  if (!fallback) return '';
  return RELATION_WORDS[edge.relation] || '';
}

/** Rank nodes by longest path over directed relations; compare edges do not constrain ranks. */
function computeRanks(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (COMPARE_RELATIONS.has(edge.relation)) continue;
    if (edge.relation === 'part_of') continue; // composition has its own template
    incoming.get(edge.to).push(edge.from);
  }
  const rank = new Map();
  const visiting = new Set();
  const walk = (id, depth) => {
    if (rank.has(id)) return rank.get(id);
    if (visiting.has(id) || depth > 24) return 0;
    visiting.add(id);
    let best = 0;
    for (const prev of incoming.get(id) || []) best = Math.max(best, walk(prev, depth + 1) + 1);
    visiting.delete(id);
    rank.set(id, best);
    return best;
  };
  for (const node of nodes) walk(node.id, 0);
  return rank;
}

function assignColumns(nodes, edges) {
  const ranks = computeRanks(nodes, edges);
  const min = Math.min(0, ...ranks.values());
  const columns = new Map();
  let maxRank = 0;
  for (const node of nodes) {
    const rank = (ranks.get(node.id) ?? 0) - min;
    maxRank = Math.max(maxRank, rank);
    if (!columns.has(rank)) columns.set(rank, []);
    columns.get(rank).push(node);
  }
  return { columns, maxRank, ranks };
}

function layeredGeometry(nodes, edges, { width, height, padding }) {
  const { columns, maxRank } = assignColumns(nodes, edges);
  const gutter = 80;
  const colCount = maxRank + 1;
  const colWidth = Math.max(180, (width - padding * 2 - gutter * (colCount - 1)) / colCount);
  const byId = new Map();
  for (const [rank, list] of columns) {
    list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id)));
    const sizes = list.map((n) => nodeSize(n.label));
    const totalHeight = sizes.reduce((sum, s) => sum + s.height, 0) + Math.max(0, list.length - 1) * 26;
    let y = Math.max(padding, (height - totalHeight) / 2);
    list.forEach((node, i) => {
      const size = sizes[i];
      const x = padding + rank * (colWidth + gutter) + (colWidth - size.width) / 2;
      byId.set(node.id, placeNode(node.id, x, y, node.label, { rank }));
      y += size.height + 26;
    });
  }
  const placed = nodes.map((n) => byId.get(n.id));
  return { placed, ranks: byId, colCount };
}

function layeredEdges(nodes, edges, placedById) {
  const out = [];
  for (const edge of edges) {
    const from = placedById.get(edge.from);
    const to = placedById.get(edge.to);
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
    let lx;
    let ly;
    if (sameColumn) {
      // Same column: route the connector through a side channel so the short
      // gap between stacked cards does not hide the arrow.
      dir = 'vertical';
      const chanX = Math.max(from.x + from.width, to.x + to.width) + 36;
      fromX = from.x + from.width;
      toX = to.x + to.width;
      fromY = from.y + from.height / 2;
      toY = to.y + to.height / 2;
      c1x = chanX;
      c1y = fromY;
      c2x = chanX;
      c2y = toY;
      lx = chanX + 12;
      ly = (fromY + toY) / 2 + 4;
    } else {
      fromX = from.x + from.width;
      fromY = from.y + from.height / 2;
      toX = to.x;
      toY = to.y + to.height / 2;
      const dx = Math.abs(toX - fromX);
      const bend = Math.min(120, Math.max(10, dx * 0.45));
      const rankFrom = from.rank ?? 0;
      const rankTo = to.rank ?? 0;
      c1x = fromX + bend;
      c1y = fromY;
      c2x = toX - bend;
      c2y = toY;
      if (backRaw) {
        dir = 'back';
        const reach = Math.min(90, Math.abs(to.x - from.x) * 0.3);
        c1x = fromX + reach;
        c1y = fromY - 120;
        c2x = toX - reach;
        c2y = toY - 120;
      } else if (rankTo - rankFrom > 1) {
        dir = 'forward-long';
        const midY = (fromY + toY) / 2;
        const below = 680 - midY - 70;
        const dip = below >= 90 ? Math.min(160, below) : -Math.min(160, midY - 60);
        const reach = Math.min(120, Math.abs(to.x - from.x) * 0.35);
        c1x = fromX + reach;
        c1y = fromY + dip;
        c2x = toX - reach;
        c2y = toY + dip;
      }
      lx = (fromX + 3 * c1x + 3 * c2x + toX) / 8;
      ly = (fromY + 3 * c1y + 3 * c2y + toY) / 8 - 10;
      for (const node of placedById.values()) {
        if (lx > node.x - 10 && lx < node.x + node.width + 10 && ly > node.y - 12 && ly < node.y + node.height + 12) {
          ly = node.y + node.height + 18;
          break;
        }
      }
    }
    lx = Math.min(Math.max(lx, 30), 1200);
    ly = Math.min(Math.max(ly, 22), 680);
    out.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      dir,
      path: `M ${round(fromX)} ${round(fromY)} C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(toX)} ${round(toY)}`,
      lx: round(lx),
      ly: round(ly),
      labelText: relationLabel(edge),
    });
  }
  return out;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function layoutLayered(nodes, edges, { width = 1200, height = 680, padding = 56 } = {}) {
  if (!nodes.length) return emptyLayout(width, height, 'layered');
  const { placed } = layeredGeometry(nodes, edges, { width, height, padding });
  const byId = new Map(placed.map((n) => [n.id, n]));
  return {
    ...emptyLayout(width, height, 'layered'),
    nodes: placed,
    edges: layeredEdges(nodes, edges, byId),
  };
}

export function layoutText(nodes, edges = [], { width = 1200, height = 680, padding = 80 } = {}) {
  if (!nodes.length) return emptyLayout(width, height, 'text');
  const maxWidth = Math.min(760, width - padding * 2);
  const left = Math.round((width - maxWidth) / 2);
  const sizes = nodes.map((n) => nodeSize(n.label, { minWidth: Math.min(320, maxWidth), maxWidth }));
  const total = sizes.reduce((sum, s) => sum + s.height, 0) + Math.max(0, nodes.length - 1) * 24;
  let y = Math.max(padding, (height - total) / 2);
  const placed = nodes.map((node, i) => {
    const size = sizes[i];
    const entry = { ...placeNode(node.id, left, y, node.label, { rank: i }), width: size.width, height: size.height };
    y += size.height + 24;
    return entry;
  });
  const byId = new Map(placed.map((n) => [n.id, n]));
  return { ...emptyLayout(width, height, 'text'), nodes: placed, edges: layeredEdges(nodes, edges, byId) };
}

/** Compare: paired items side by side, connected by a symmetric dashed axis. */
export function layoutCompare(nodes, edges, { width = 1200, height = 680 } = {}) {
  if (!nodes.length) return emptyLayout(width, height, 'compare');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pairs = [];
  const used = new Set();
  for (const edge of edges) {
    if (!COMPARE_RELATIONS.has(edge.relation)) continue;
    if (used.has(edge.from) || used.has(edge.to)) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    used.add(edge.from);
    used.add(edge.to);
    pairs.push({ edge, left: byId.get(edge.from), right: byId.get(edge.to) });
  }
  const singles = nodes.filter((n) => !used.has(n.id));
  for (let i = 0; i < singles.length; i += 2) {
    pairs.push({ edge: null, left: singles[i], right: singles[i + 1] || null });
  }

  const gutter = 96;
  const rowGap = 44;
  const pairWidths = pairs.map(({ left, right }) => {
    const l = nodeSize(left.label);
    const r = right ? nodeSize(right.label) : null;
    return r ? l.width + gutter + r.width : l.width;
  });
  const contentWidth = Math.max(...pairWidths);
  const left = Math.max(40, (width - contentWidth) / 2);
  const heights = pairs.map(({ left, right }) => Math.max(nodeSize(left.label).height, right ? nodeSize(right.label).height : 0));
  const total = heights.reduce((a, b) => a + b, 0) + rowGap * Math.max(0, pairs.length - 1);
  let y = Math.max(120, (height - total) / 2);

  const placed = [];
  const outEdges = [];
  pairs.forEach(({ edge, left: leftNode, right: rightNode }, index) => {
    const lSize = nodeSize(leftNode.label);
    const rSize = rightNode ? nodeSize(rightNode.label) : null;
    const rowWidth = rSize ? lSize.width + gutter + rSize.width : lSize.width;
    const rowLeft = left + (contentWidth - rowWidth) / 2;
    const rowHeight = heights[index];
    const ly = y + (rowHeight - lSize.height) / 2;
    placed.push({ ...placeNode(leftNode.id, rowLeft, ly, leftNode.label, { rank: 0 }) });
    if (rightNode) {
      const rx = rowLeft + lSize.width + gutter;
      const ry = y + (rowHeight - rSize.height) / 2;
      placed.push({ ...placeNode(rightNode.id, rx, ry, rightNode.label, { rank: 1 }) });
      const x1 = rowLeft + lSize.width;
      const x2 = rx;
      const cy = y + rowHeight / 2;
      outEdges.push({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        relation: edge.relation,
        dir: 'compare',
        path: `M ${round(x1)} ${round(cy)} L ${round(x2)} ${round(cy)}`,
        lx: round((x1 + x2) / 2),
        ly: round(cy - 12),
        labelText: relationLabel(edge),
      });
    }
    y += rowHeight + rowGap;
  });
  return { ...emptyLayout(width, height, 'compare'), nodes: placed, edges: outEdges };
}

/** Composition: stacked parts inside a container, or a part→whole chain. */
export function layoutComposition(nodes, edges, { width = 1200, height = 680 } = {}) {
  if (!nodes.length) return emptyLayout(width, height, 'composition');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const partEdges = edges.filter((e) => e.relation === 'part_of' && byId.has(e.from) && byId.has(e.to));
  const partsOf = new Map();
  for (const edge of partEdges) {
    if (!partsOf.has(edge.to)) partsOf.set(edge.to, []);
    partsOf.get(edge.to).push(edge.from);
  }
  const multi = [...partsOf.entries()].filter(([, parts]) => new Set(parts).size >= 2);

  if (!multi.length) {
    // Chain: part→whole is a hierarchy, keep every layer on the same axis.
    const geom = partEdges.map((e) => ({ ...e, relation: 'causes' }));
    const { placed } = layeredGeometry(nodes, geom, { width, height, padding: 72 });
    const placedById = new Map(placed.map((n) => [n.id, n]));
    const outEdges = layeredEdges(nodes, geom, placedById).map((e) => ({ ...e, labelText: relationLabel(partEdges.find((x) => x.id === e.id), false) }));
    return { ...emptyLayout(width, height, 'composition'), nodes: placed, edges: outEdges };
  }

  const groupOf = new Map();
  const specs = [];
  for (const [wholeId, partIds] of multi) {
    const whole = byId.get(wholeId);
    const parts = [...new Set(partIds)].map((id) => byId.get(id)).filter(Boolean);
    for (const p of [whole, ...parts]) groupOf.set(p.id, wholeId);
    const maxW = Math.max(nodeSize(whole.label).width, ...parts.map((p) => nodeSize(p.label).width));
    const innerW = Math.max(maxW, 260);
    const gap = 18;
    const headH = nodeSize(whole.label).height;
    const partsH = parts.reduce((sum, p) => sum + nodeSize(p.label).height, 0) + gap * Math.max(0, parts.length - 1);
    const boxW = innerW + 84;
    const boxH = 34 + headH + 26 + partsH + 26;
    specs.push({ whole, parts, boxW, boxH, innerW, headH, gap });
  }
  const loose = nodes.filter((n) => !groupOf.has(n.id));

  const boxGap = 36;
  const rows = [];
  let row = [];
  let rowW = 0;
  for (const spec of specs) {
    if (row.length && rowW + boxGap + spec.boxW > width - 48) {
      rows.push(row);
      row = [];
      rowW = 0;
    }
    row.push(spec);
    rowW += spec.boxW + (row.length > 1 ? boxGap : 0);
  }
  if (row.length) rows.push(row);

  const groupBoxes = [];
  const placed = [];
  const outEdges = [];
  let cursorY = 104;
  for (const specsRow of rows) {
    const rowWidth = specsRow.reduce((sum, s) => sum + s.boxW, 0) + boxGap * (specsRow.length - 1);
    let x = Math.max(40, (width - rowWidth) / 2);
    const rowH = Math.max(...specsRow.map((s) => s.boxH));
    for (const spec of specsRow) {
      const boxY = cursorY + (rowH - spec.boxH) / 2;
      groupBoxes.push({
        id: `g_${spec.whole.id}`,
        x: round(x),
        y: round(boxY),
        width: round(spec.boxW),
        height: round(spec.boxH),
        label: '',
        family: 'composition',
      });
      const nodeX = x + 20;
      const nodeW = spec.innerW;
      const spineX = x + spec.boxW - 22;
      const wholeY = boxY + 34;
      const wholeSize = nodeSize(spec.whole.label);
      placed.push({ ...placeNode(spec.whole.id, nodeX, wholeY, spec.whole.label, { group: `g_${spec.whole.id}` }), width: nodeW });
      let partY = wholeY + spec.headH + 26;
      const partSpots = [];
      for (const part of spec.parts) {
        const partSize = nodeSize(part.label);
        placed.push({ ...placeNode(part.id, nodeX, partY, part.label, { group: `g_${spec.whole.id}` }), width: nodeW });
        partSpots.push({ part, partY, partSize });
        partY += partSize.height + spec.gap;
      }
      // One bracket per container: part elbows join a right-hand spine that ends
      // with a single arrow into the whole. Avoids five overlapping squiggles.
      const topPartCy = partSpots.length ? partSpots[0].partY + partSpots[0].partSize.height / 2 : wholeY;
      const lastIndex = partSpots.length - 1;
      partSpots.forEach((spot, index) => {
        const edge = partEdges.find((e) => e.from === spot.part.id && e.to === spec.whole.id);
        if (!edge) return;
        const px = nodeX + nodeW;
        const py = spot.partY + spot.partSize.height / 2;
        const wholeCy = wholeY + wholeSize.height / 2;
        const path = index === lastIndex
          ? `M ${round(px)} ${round(py)} L ${round(spineX)} ${round(py)} L ${round(spineX)} ${round(topPartCy)} L ${round(spineX)} ${round(wholeCy)} L ${round(nodeX + nodeW)} ${round(wholeCy)}`
          : `M ${round(px)} ${round(py)} L ${round(spineX)} ${round(py)}`;
        outEdges.push({
          id: edge.id,
          from: spot.part.id,
          to: spec.whole.id,
          relation: 'part_of',
          dir: 'part',
          arrow: index === lastIndex,
          path,
          lx: round(spineX + 6),
          ly: round(py - 8),
          labelText: relationLabel(edge, false),
        });
      });
      x += spec.boxW + boxGap;
    }
    cursorY += rowH + 44;
  }

  if (loose.length) {
    const maxW = Math.max(...loose.map((n) => nodeSize(n.label).width));
    const left = Math.max(40, (width - maxW) / 2);
    let y = Math.max(cursorY, height - loose.reduce((sum, n) => sum + nodeSize(n.label).height, 0) - (loose.length - 1) * 18 - 60);
    for (const n of loose) {
      placed.push(placeNode(n.id, left, y, n.label));
      y += nodeSize(n.label).height + 18;
    }
  }
  return { ...emptyLayout(width, height, 'composition'), nodes: placed, edges: outEdges, groups: groupBoxes };
}

/** Convergence: sources stack on the left and fan into the target on the right. */
export function layoutConvergence(nodes, edges, { width = 1200, height = 680 } = {}) {
  if (!nodes.length) return emptyLayout(width, height, 'convergence');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const conv = edges.filter((e) => e.relation === 'converges_to' && byId.has(e.from) && byId.has(e.to));
  const targets = [...new Set(conv.map((e) => e.to))];
  const sources = [...new Set(conv.map((e) => e.from))];
  if (!conv.length) return layoutLayered(nodes, edges, { width, height });

  const used = new Set([...targets, ...sources]);
  const loose = nodes.filter((n) => !used.has(n.id));
  const targetNodes = targets.map((id) => byId.get(id));
  const sourceNodes = sources.map((id) => byId.get(id));

  const sourceGap = 22;
  const sourceTotal = sourceNodes.reduce((sum, n) => sum + nodeSize(n.label).height, 0) + sourceGap * Math.max(0, sourceNodes.length - 1);
  const targetTotal = targetNodes.reduce((sum, n) => sum + nodeSize(n.label).height, 0) + 24 * Math.max(0, targetNodes.length - 1);
  const blockH = Math.max(sourceTotal, targetTotal, 160);
  const top = Math.max(110, (height - blockH) / 2);
  const leftX = Math.max(48, width * 0.08);
  const rightX = Math.max(leftX + 320, width * 0.62);

  const placed = [];
  const placedById = new Map();
  let y = top + (blockH - sourceTotal) / 2;
  for (const n of sourceNodes) {
    const entry = placeNode(n.id, leftX, y, n.label);
    placed.push(entry);
    placedById.set(n.id, entry);
    y += nodeSize(n.label).height + sourceGap;
  }
  let ty = top + (blockH - targetTotal) / 2;
  for (const n of targetNodes) {
    const entry = placeNode(n.id, rightX, ty, n.label, { role: 'target' });
    placed.push(entry);
    placedById.set(n.id, entry);
    ty += nodeSize(n.label).height + 24;
  }
  for (const n of loose) {
    placed.push(placeNode(n.id, leftX, top + blockH + 30, n.label));
  }

  const outEdges = [];
  const labelledTargets = new Set();
  for (const edge of conv) {
    const from = placedById.get(edge.from);
    const to = placedById.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.min(90, Math.abs(x2 - x1) * 0.5);
    labelledTargets.add(edge.to);
    outEdges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      dir: 'converge',
      path: `M ${round(x1)} ${round(y1)} C ${round(x1 + bend)} ${round(y1)}, ${round(x2 - bend)} ${round(y2)}, ${round(x2)} ${round(y2)}`,
      lx: round((x1 + x2) / 2),
      ly: round((y1 + y2) / 2 - 10),
      labelText: labelledTargets.has(edge.to) ? '' : relationLabel(edge),
    });
  }
  return { ...emptyLayout(width, height, 'convergence'), nodes: placed, edges: outEdges, targets: targetNodes.map((n) => n.id) };
}

function emptyLayout(width, height, kind) {
  return { nodes: [], edges: [], groups: [], width, height, kind };
}

/** Generic entry point used by the renderer. */
export function layoutScene({ scene, nodes, edges, width = 1200, height = 680 } = {}) {
  const visibleNodes = (nodes || []).filter((n) => n.state !== 'retracted');
  const visibleEdges = (edges || []).filter(
    (e) => e.state !== 'retracted' && visibleNodes.some((n) => n.id === e.from) && visibleNodes.some((n) => n.id === e.to)
  );
  const family = scene ? scene.family : 'text';
  const capacity = {
    nodes: visibleNodes.length,
    edges: visibleEdges.length,
    max_nodes: MAX_VISIBLE_NODES,
    max_edges: MAX_VISIBLE_EDGES,
    exceeded: visibleNodes.length > MAX_VISIBLE_NODES || visibleEdges.length > MAX_VISIBLE_EDGES,
  };
  let layout;
  if (!visibleNodes.length) layout = emptyLayout(width, height, family);
  else if (family === 'compare') layout = layoutCompare(visibleNodes, visibleEdges, { width, height });
  else if (family === 'composition') layout = layoutComposition(visibleNodes, visibleEdges, { width, height });
  else if (family === 'convergence') layout = layoutConvergence(visibleNodes, visibleEdges, { width, height });
  else if (!visibleEdges.length) layout = layoutText(visibleNodes, [], { width, height });
  else if (family === 'text') layout = layoutText(visibleNodes, visibleEdges, { width, height });
  else layout = layoutLayered(visibleNodes, visibleEdges, { width, height });
  const targets = layout.targets || (family === 'convergence' ? visibleNodes.filter((n) => visibleEdges.some((e) => e.relation === 'converges_to' && e.to === n.id)).map((n) => n.id) : []);
  return { ...layout, family, capacity, targets };
}

export function relationWord(relation, label) {
  if (label && String(label).trim()) return String(label).trim();
  return RELATION_WORDS[relation] || '';
}
