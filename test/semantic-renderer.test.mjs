import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDoc, makeContainer } from './helpers/dom.mjs';
import { SemanticRenderer } from '../public/semantic/renderer.js';
import { layoutScene, relationWord, layoutText } from '../public/semantic/layouts.js';

function node(id, label, extra = {}) {
  return { id, label, claim_kind: 'assertion', state: 'supported', role: 'cause', created_at: 1, origin: 'model', ...extra };
}

function edge(id, from, to, extra = {}) {
  return { id, from, to, relation: 'causes', label: '', state: 'supported', ...extra };
}

function baseState() {
  return {
    schema_version: 1,
    epoch: 1,
    graph_version: 1,
    active_scene_id: 's1',
    scenes: {
      s1: {
        id: 's1',
        title: '资料分散导致查找耗时',
        family: 'cause',
        status: 'active',
        focus_ids: ['n2'],
        node_ids: ['n1', 'n2', 'n3'],
        edge_ids: ['e1', 'e2'],
      },
    },
    nodes: {
      n1: node('n1', '资料分散'),
      n2: node('n2', '来回切换'),
      n3: node('n3', '查找花费更多时间'),
    },
    edges: {
      e1: edge('e1', 'n1', 'n2'),
      e2: edge('e2', 'n2', 'n3'),
    },
    receipts: {},
    unresolved: [],
    history: [],
  };
}

function setup() {
  const doc = makeDoc();
  const container = makeContainer(doc);
  const renderer = new SemanticRenderer(container, { doc, reducedMotion: true, animate: false });
  return { doc, container, renderer };
}

test('layout places a causal chain left to right', () => {
  const state = baseState();
  const layout = layoutScene({
    scene: state.scenes.s1,
    nodes: Object.values(state.nodes),
    edges: Object.values(state.edges),
    width: 1200,
    height: 680,
  });
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  assert.ok(byId.get('n1').x < byId.get('n2').x);
  assert.ok(byId.get('n2').x < byId.get('n3').x);
  for (const n of layout.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0);
    assert.ok(n.x + n.width <= 1200);
  }
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.edges[0].path.startsWith('M '));
});

test('text layout keeps a single readable column', () => {
  const state = baseState();
  const layout = layoutText(Object.values(state.nodes), [], { width: 1280, height: 720 });
  assert.equal(new Set(layout.nodes.map((n) => n.x)).size, 1);
  assert.ok(layout.nodes[0].y < layout.nodes[1].y);
});

test('compare pairs sit side by side around a shared dashed axis', () => {
  const nodes = [node('a', '统一入口', { created_at: 1 }), node('b', '维持现状', { created_at: 2 })];
  const edges = [edge('ab', 'a', 'b', { relation: 'contrasts' })];
  const layout = layoutScene({
    scene: { id: 's', family: 'compare', node_ids: ['a', 'b'], edge_ids: ['ab'] },
    nodes,
    edges,
    width: 1200,
    height: 680,
  });
  const [placed] = layout.edges;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  assert.equal(placed.dir, 'compare');
  assert.equal(placed.labelText, '对比');
  assert.ok(byId.get('a').x < byId.get('b').x);
  assert.ok(Math.abs(byId.get('a').y - byId.get('b').y) < 40);
  assert.ok(placed.lx > byId.get('a').x + byId.get('a').width);
  assert.ok(placed.lx < byId.get('b').x);
});

test('composition stacks parts inside one container', () => {
  const nodes = [
    node('w', '一次查找', { created_at: 1 }),
    node('p1', '打开微信', { created_at: 2 }),
    node('p2', '打开文档', { created_at: 3 }),
    node('p3', '打开表格', { created_at: 4 }),
  ];
  const edges = [
    edge('e1', 'p1', 'w', { relation: 'part_of' }),
    edge('e2', 'p2', 'w', { relation: 'part_of' }),
    edge('e3', 'p3', 'w', { relation: 'part_of' }),
  ];
  const layout = layoutScene({
    scene: { id: 's', family: 'composition', node_ids: nodes.map((n) => n.id), edge_ids: edges.map((e) => e.id) },
    nodes,
    edges,
    width: 1200,
    height: 680,
  });
  assert.equal(layout.groups.length, 1);
  const group = layout.groups[0];
  for (const placed of layout.nodes) {
    assert.ok(placed.x >= group.x && placed.x + placed.width <= group.x + group.width);
    assert.ok(placed.y >= group.y && placed.y + placed.height <= group.y + group.height);
  }
  assert.equal(layout.edges.length, 3);
  for (const e of layout.edges) assert.equal(e.labelText, '');
});

test('composition chain keeps every layer from one to five', () => {
  for (let depth = 1; depth <= 5; depth += 1) {
    const nodes = Array.from({ length: depth + 1 }, (_, i) => node(`n${i}`, `第${i + 1}层`, { created_at: i + 1 }));
    const edges = Array.from({ length: depth }, (_, i) => edge(`e${i}`, `n${i}`, `n${i + 1}`, { relation: 'part_of' }));
    const layout = layoutScene({
      scene: { id: 's', family: 'composition', node_ids: nodes.map((n) => n.id), edge_ids: edges.map((e) => e.id) },
      nodes,
      edges,
      width: 1200,
      height: 680,
    });
    assert.equal(layout.nodes.length, depth + 1);
    assert.equal(layout.edges.length, depth);
    for (let i = 1; i < layout.nodes.length; i += 1) {
      assert.ok(layout.nodes[i - 1].x < layout.nodes[i].x);
    }
  }
});

test('convergence fans sources into a target on the right', () => {
  const nodes = [
    node('t', '统一入口', { created_at: 1 }),
    node('s1', '微信资料', { created_at: 2 }),
    node('s2', '文档资料', { created_at: 3 }),
    node('s3', '表格资料', { created_at: 4 }),
  ];
  const edges = [
    edge('e1', 's1', 't', { relation: 'converges_to' }),
    edge('e2', 's2', 't', { relation: 'converges_to' }),
    edge('e3', 's3', 't', { relation: 'converges_to' }),
  ];
  const layout = layoutScene({
    scene: { id: 's', family: 'convergence', node_ids: nodes.map((n) => n.id), edge_ids: edges.map((e) => e.id) },
    nodes,
    edges,
    width: 1200,
    height: 680,
  });
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const id of ['s1', 's2', 's3']) assert.ok(byId.get(id).x < byId.get('t').x);
  assert.deepEqual(layout.targets, ['t']);
  for (const e of layout.edges) assert.equal(e.dir, 'converge');
});

test('composition container and members keep identity while parts are added', () => {
  const { renderer } = setup();
  const nodes = [
    node('w', '一次查找', { created_at: 1 }),
    node('p1', '打开微信', { created_at: 2 }),
    node('p2', '打开文档', { created_at: 3 }),
  ];
  const edges = [edge('e1', 'p1', 'w', { relation: 'part_of' }), edge('e2', 'p2', 'w', { relation: 'part_of' })];
  const state = baseState();
  state.scenes.s1 = {
    id: 's1',
    title: '组成',
    family: 'composition',
    status: 'active',
    focus_ids: [],
    node_ids: ['w', 'p1', 'p2'],
    edge_ids: ['e1', 'e2'],
  };
  state.nodes = Object.fromEntries(nodes.map((n) => [n.id, n]));
  state.edges = Object.fromEntries(edges.map((e) => [e.id, e]));
  renderer.render(state);
  const groupBefore = renderer.elements().groups.size ? [...renderer.elements().groups.values()][0].el : null;
  assert.ok(groupBefore);
  const nodeRefs = new Map([...renderer.elements().nodes].map(([id, rec]) => [id, rec.el]));

  const next = JSON.parse(JSON.stringify(state));
  next.nodes.p3 = node('p3', '打开表格', { created_at: 4 });
  next.edges.e3 = edge('e3', 'p3', 'w', { relation: 'part_of' });
  next.scenes.s1.node_ids.push('p3');
  next.scenes.s1.edge_ids.push('e3');
  renderer.render(next);
  const groupAfter = [...renderer.elements().groups.values()][0].el;
  assert.equal(groupAfter, groupBefore);
  assert.equal(renderer.elements().nodes.get('p1').el, nodeRefs.get('p1'));
  assert.equal(renderer.elements().nodes.get('p3').el.dataset.born ?? '', '');
});

test('over capacity reports continuation without dropping nodes', () => {
  const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`, `观点${i + 1}`, { created_at: i + 1 }));
  const edges = nodes.slice(1).map((n, i) => edge(`e${i}`, `n${i}`, `n${i + 1}`));
  const layout = layoutScene({
    scene: { id: 's', family: 'cause', node_ids: nodes.map((n) => n.id), edge_ids: edges.map((e) => e.id) },
    nodes,
    edges,
    width: 1200,
    height: 680,
  });
  assert.equal(layout.capacity.exceeded, true);
  assert.equal(layout.nodes.length, 7);
  const { renderer } = setup();
  const state = baseState();
  state.scenes.s1.node_ids = nodes.map((n) => n.id);
  state.scenes.s1.edge_ids = edges.map((e) => e.id);
  state.nodes = Object.fromEntries(nodes.map((n) => [n.id, n]));
  state.edges = Object.fromEntries(edges.map((e) => [e.id, e]));
  renderer.render(state);
  assert.equal(renderer.elements().nodes.size, 7);
  assert.match(renderer.capacityEl.textContent, /续接/);
});

test('edges that skip a rank dip outside the columns', () => {
  const nodes = [node('a', '起点', { created_at: 1 }), node('b', '中间', { created_at: 2 }), node('c', '终点', { created_at: 3 })];
  const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ac', 'a', 'c')];
  const layout = layoutScene({
    scene: { id: 's', family: 'cause', node_ids: ['a', 'b', 'c'], edge_ids: ['ab', 'bc', 'ac'] },
    nodes,
    edges,
    width: 1200,
    height: 680,
  });
  const direct = layout.edges.find((e) => e.id === 'ac');
  assert.equal(direct.dir, 'forward-long');
  const maxBottom = Math.max(...layout.nodes.map((n) => n.y + n.height));
  assert.ok(direct.path.includes('C'));
  assert.ok(Number(direct.ly) > 0);
  assert.ok(maxBottom > 0);
});

test('relation labels fall back to Chinese words', () => {
  assert.equal(relationWord('causes', ''), '导致');
  assert.equal(relationWord('contrasts', ''), '对比');
  assert.equal(relationWord('causes', '带来'), '带来');
});

test('render reuses one element per node and edge across updates', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  const first = renderer.elements();
  const refs = new Map([...first.nodes].map(([id, rec]) => [id, rec.el]));
  const edgeRefs = new Map([...first.edges].map(([id, rec]) => [id, rec.g]));
  assert.equal(refs.size, 3);
  assert.equal(edgeRefs.size, 2);
  assert.equal(first.nodes.get('n2').el.classList.contains('is-focus'), true);

  const next = baseState();
  next.graph_version = 2;
  next.nodes.n2.label = '来回切换资料';
  renderer.render(next);
  const second = renderer.elements();
  for (const [id, el] of refs) assert.equal(second.nodes.get(id).el, el, `node ${id} rebuilt`);
  for (const [id, g] of edgeRefs) assert.equal(second.edges.get(id).g, g, `edge ${id} rebuilt`);
  assert.equal(second.nodes.get('n2').label.textContent, '来回切换资料');
  assert.equal(second.nodes.get('n2').el.style.transform, first.nodes.get('n2').el.style.transform);
});

test('adding a node appends only the new element', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  const before = new Map([...renderer.elements().nodes].map(([id, rec]) => [id, rec.el]));
  const next = baseState();
  next.scenes.s1.node_ids = ['n1', 'n2', 'n3', 'n4'];
  next.scenes.s1.edge_ids = ['e1', 'e2', 'e3'];
  next.nodes.n4 = node('n4', '新证据', { created_at: 2 });
  next.edges.e3 = edge('e3', 'n1', 'n4');
  renderer.render(next);
  const after = renderer.elements().nodes;
  assert.equal(after.size, 4);
  for (const [id, el] of before) assert.equal(after.get(id).el, el);
  assert.ok(after.get('n4'));
  assert.match(after.get('n4').el.style.transform, /translate3d/);
});

test('retracting a node and its edge removes them without touching siblings', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  const keep = renderer.elements().nodes.get('n1').el;
  const next = baseState();
  next.nodes.n2.state = 'retracted';
  next.scenes.s1.node_ids = ['n1', 'n3'];
  next.scenes.s1.edge_ids = ['e2'];
  renderer.render(next);
  assert.equal(renderer.elements().nodes.size, 2);
  assert.equal(renderer.elements().nodes.get('n1').el, keep);
  assert.equal(renderer.elements().edges.size, 0, 'edge to a removed node must go');
});

test('model text never becomes markup', () => {
  const { renderer } = setup();
  const state = baseState();
  state.nodes.n2.label = '<img src=x onerror=alert(1)>';
  renderer.render(state);
  const rec = renderer.elements().nodes.get('n2');
  assert.equal(rec.label.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(rec.label.children.length, 0);
  assert.equal(rec.el.children.length, 3);
});

test('reduced motion adds no entry or draw classes', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  for (const [, rec] of renderer.elements().nodes) {
    assert.equal(rec.el.classList.contains('sem-enter'), false);
  }
  for (const [, rec] of renderer.elements().edges) {
    assert.equal(rec.path.classList.contains('sem-draw'), false);
  }
  assert.equal(renderer.snapshot().reduced_motion, true);
});

test('switching scenes swaps all elements and title', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  const next = baseState();
  next.scenes.s1.status = 'archived';
  next.scenes.s2 = { id: 's2', title: '价格对比', family: 'compare', status: 'active', focus_ids: [], node_ids: ['n9', 'n10'], edge_ids: ['e9'] };
  next.nodes.n9 = node('n9', '高价方案');
  next.nodes.n10 = node('n10', '低价方案');
  next.edges.e9 = edge('e9', 'n9', 'n10', { relation: 'contrasts' });
  next.active_scene_id = 's2';
  renderer.render(next);
  const snap = renderer.snapshot();
  assert.equal(snap.scene_id, 's2');
  assert.equal(snap.title, '价格对比');
  assert.deepEqual([...renderer.elements().nodes.keys()].sort(), ['n10', 'n9']);
  assert.equal(renderer.elements().edges.get('e9').path.classList.contains('is-tentative'), false);
});

test('viewBox matches the measured stage so SVG and DOM stay aligned', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  assert.equal(renderer.elements().root.querySelector('svg').getAttribute('viewBox'), '0 0 1200 680');
});

test('snapshot exposes geometry and dom counts for later diffing', () => {
  const { renderer } = setup();
  renderer.render(baseState());
  const snap = renderer.snapshot();
  assert.equal(snap.dom.nodes, 3);
  assert.equal(snap.dom.edges, 2);
  assert.equal(snap.nodes.find((n) => n.id === 'n2').text, '来回切换');
  assert.ok(snap.width > 0 && snap.height > 0);
});

test('hypothesis and tentative markers reach the flag and edge state', () => {
  const { renderer } = setup();
  const state = baseState();
  state.nodes.n1.claim_kind = 'hypothesis';
  state.nodes.n1.state = 'tentative';
  state.edges.e1.state = 'tentative';
  renderer.render(state);
  assert.equal(renderer.elements().nodes.get('n1').flag.textContent, '设想 · 待确认');
  assert.equal(renderer.elements().edges.get('e1').g.classList.contains('is-tentative'), true);
});
