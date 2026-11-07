import { SemanticRenderer } from './renderer.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function base() {
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
        focus_ids: [],
        node_ids: ['n1', 'n2'],
        edge_ids: ['e1'],
      },
    },
    nodes: {
      n1: { id: 'n1', label: '资料放在微信、文档和表格里', claim_kind: 'assertion', state: 'supported', role: 'cause', created_at: 1 },
      n2: { id: 'n2', label: '找东西时来回切换', claim_kind: 'assertion', state: 'supported', role: 'effect', created_at: 2 },
    },
    edges: {
      e1: { id: 'e1', from: 'n1', to: 'n2', relation: 'causes', label: '', state: 'supported' },
    },
    receipts: {},
    unresolved: [],
    history: [],
  };
}

const STEPS = [
  {
    label: '收到第一句：分散存储导致来回切换',
    apply(state) {
      state.scenes.s1.focus_ids = ['n2'];
    },
  },
  {
    label: '新增后果节点：切换让人花更多时间',
    apply(state) {
      const scene = state.scenes.s1;
      state.nodes.n3 = { id: 'n3', label: '切换让我花更多时间', claim_kind: 'assertion', state: 'supported', role: 'effect', created_at: 3 };
      state.edges.e2 = { id: 'e2', from: 'n2', to: 'n3', relation: 'causes', label: '', state: 'supported' };
      scene.node_ids.push('n3');
      scene.edge_ids.push('e2');
      scene.focus_ids = ['n3'];
    },
  },
  {
    label: '补充来源分组：三处存放（part_of 指向“资料分散”）',
    apply(state) {
      const scene = state.scenes.s1;
      state.nodes.n4 = { id: 'n4', label: '微信 / 文档 / 表格', claim_kind: 'assertion', state: 'supported', role: 'cause', created_at: 4 };
      state.edges.e3 = { id: 'e3', from: 'n4', to: 'n1', relation: 'part_of', label: '组成', state: 'supported' };
      scene.node_ids.unshift('n4');
      scene.edge_ids.unshift('e3');
    },
  },
  {
    label: '修正文案：只改“来回切换”的标签，其他对象不动',
    apply(state) {
      state.nodes.n2.label = '在多个工具之间来回切换';
      state.graph_version = 4;
    },
  },
  {
    label: '新输入是设想：统一入口也许能减少切换（虚线 / 待确认）',
    apply(state) {
      const scene = state.scenes.s1;
      state.nodes.n5 = {
        id: 'n5',
        label: '如果做一个统一入口，也许能减少切换',
        claim_kind: 'hypothesis',
        state: 'tentative',
        role: 'proposal',
        created_at: 5,
      };
      state.edges.e4 = { id: 'e4', from: 'n5', to: 'n2', relation: 'conditional', label: '若', state: 'tentative' };
      scene.node_ids.push('n5');
      scene.edge_ids.push('e4');
      scene.focus_ids = ['n5'];
    },
  },
  {
    label: '撤回被更好说法替代的分组节点（只删它和它的边）',
    apply(state) {
      const scene = state.scenes.s1;
      state.nodes.n4.state = 'retracted';
      state.edges.e3.state = 'retracted';
      scene.node_ids = scene.node_ids.filter((id) => id !== 'n4');
      scene.edge_ids = scene.edge_ids.filter((id) => id !== 'e3');
    },
  },
  {
    label: '切到对比场景：统一入口 vs 维持现状',
    apply(state) {
      state.scenes.s1.status = 'archived';
      state.scenes.s2 = {
        id: 's2',
        title: '两种方案的取舍',
        family: 'compare',
        status: 'active',
        focus_ids: ['n7'],
        node_ids: ['n6', 'n7'],
        edge_ids: ['e6'],
      };
      state.nodes.n6 = { id: 'n6', label: '统一入口：学习成本更高', claim_kind: 'assertion', state: 'supported', role: 'subject', created_at: 6 };
      state.nodes.n7 = { id: 'n7', label: '维持现状：继续切换', claim_kind: 'assertion', state: 'supported', role: 'subject', created_at: 7 };
      state.edges.e6 = { id: 'e6', from: 'n6', to: 'n7', relation: 'contrasts', label: '', state: 'supported' };
      state.active_scene_id = 's2';
    },
  },
  {
    label: '回到因果场景：状态完整恢复，不重播旧动画',
    apply(state) {
      state.scenes.s2.status = 'archived';
      state.scenes.s1.status = 'active';
      state.scenes.s1.focus_ids = ['n2'];
      state.active_scene_id = 's1';
    },
  },
  {
    label: '减少动态效果：语义不变，运动关闭',
    apply() {},
    reducedMotion: true,
  },
];

const holder = document.getElementById('stage');
const labelEl = document.getElementById('step-label');
const statsEl = document.getElementById('stats');
const nextBtn = document.getElementById('next');
const autoBtn = document.getElementById('auto');
const resetBtn = document.getElementById('reset');
const motionBtn = document.getElementById('motion');

const renderer = new SemanticRenderer(holder, { reducedMotion: false, animate: true });
let state = base();
let cursor = 0;
let reduced = false;
let autoTimer = null;
let identityKept = 0;
let identityCreated = 0;

function renderStep(stepIndex, { animate = true } = {}) {
  const next = clone(state);
  const step = STEPS[stepIndex - 1];
  step.apply(next);
  if (step.reducedMotion) reduced = true;

  const before = new Map([...renderer.elements().nodes].map(([id, rec]) => [id, rec.el]));
  const beforeEdges = new Map([...renderer.elements().edges].map(([id, rec]) => [id, rec.g]));
  renderer.render(next, { animate: animate && !reduced, reason: `step-${stepIndex}` });

  for (const [id, rec] of renderer.elements().nodes) {
    if (before.get(id) === rec.el) {
      identityKept += 1;
    } else {
      identityCreated += 1;
      rec.el.dataset.born = String(stepIndex);
    }
  }
  for (const [id, rec] of renderer.elements().edges) {
    if (beforeEdges.get(id) === rec.g) identityKept += 1;
    else identityCreated += 1;
  }

  state = next;
  cursor = stepIndex;
  labelEl.textContent = `第 ${stepIndex}/${STEPS.length} 步：${step.label}`;
  const snap = renderer.snapshot();
  while (statsEl.firstChild) statsEl.removeChild(statsEl.firstChild);
  const lines = [
    `场景：${snap.title || '—'}（${snap.family || 'text'}）`,
    `节点 ${snap.dom.nodes} · 边 ${snap.dom.edges}`,
    `身份保持 ${identityKept} 次 · 新建 ${identityCreated} 次`,
    `减少动态：${reduced ? '开' : '关'}`,
  ];
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    statsEl.appendChild(div);
  }
  nextBtn.disabled = cursor >= STEPS.length;
  autoBtn.disabled = cursor >= STEPS.length;
}

function reset() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  renderer.setReducedMotion(false);
  reduced = false;
  motionBtn.textContent = '减少动态：关';
  state = base();
  cursor = 0;
  identityKept = 0;
  identityCreated = 0;
  renderer.render(state, { animate: false, reason: 'reset' });
  labelEl.textContent = '准备开始';
  statsEl.textContent = '尚未开始。';
  nextBtn.disabled = false;
  autoBtn.disabled = false;
}

nextBtn.addEventListener('click', () => {
  if (cursor < STEPS.length) renderStep(cursor + 1);
});

autoBtn.addEventListener('click', () => {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    autoBtn.textContent = '自动播放';
    return;
  }
  autoBtn.textContent = '暂停';
  autoTimer = setInterval(() => {
    if (cursor >= STEPS.length) {
      clearInterval(autoTimer);
      autoTimer = null;
      autoBtn.textContent = '自动播放';
      return;
    }
    renderStep(cursor + 1);
  }, 1300);
});

resetBtn.addEventListener('click', reset);

motionBtn.addEventListener('click', () => {
  reduced = !reduced;
  renderer.setReducedMotion(reduced);
  motionBtn.textContent = `减少动态：${reduced ? '开' : '关'}`;
});

reset();

function render() {
  renderer.render(state, { animate: false, reason: 'init' });
}

// Browser-check hook: identity and layout assertions can read this directly.
window.semPreview = {
  get state() {
    return state;
  },
  steps: STEPS.map((s) => s.label),
  renderer,
  get identity() {
    return { kept: identityKept, created: identityCreated };
  },
  go(step) {
    while (cursor < step && cursor < STEPS.length) renderStep(cursor + 1);
  },
};
