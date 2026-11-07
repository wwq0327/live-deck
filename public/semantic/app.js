// ?mode=semantic 的浏览器入口：账本 → 调度 → Store → 稳定渲染。
// 输入仍由 stage.js 现有的麦克风/VAD/ASR 管线提供，这里不复制第二套采集。
import { TranscriptLedger } from './transcript.js';
import { SemanticStore } from './store.js';
import { SemanticScheduler } from './scheduler.js';
import { SemanticRenderer } from './renderer.js';
import { SemanticPresenter } from './presenter.js';

// C01：同一段的三次 partial 与 final 的时间线。只用于无麦克风时的增量回放。
const C01_EVENTS = [
  { at_ms: 0, phase: 'partial', revision: 1, text: '资料放在微信' },
  { at_ms: 1000, phase: 'partial', revision: 2, text: '资料放在微信、文档和表格里' },
  {
    at_ms: 2200,
    phase: 'partial',
    revision: 3,
    text: '资料放在微信、文档和表格里，所以找东西时我得来回切换',
  },
  {
    at_ms: 4000,
    phase: 'final',
    revision: 4,
    text: '资料放在微信、文档和表格里，所以找东西时我得来回切换，切换让我花更多时间',
  },
];

const STATUS_LABELS = {
  听: '在听',
  转写: '转写中',
  待机: '等待输入',
  思考: '理解中',
};

export function startSemantic({ deck, liveLabel, latEl, capEl, capWrap }) {
  document.body.classList.add('semantic');
  document.documentElement.style.setProperty('--accent', '#4fe08d');
  deck.textContent = '';

  for (const el of document.querySelectorAll('#bar button')) {
    if (el.id === 'go') el.textContent = '送入';
    if (el.id === 'demo') el.textContent = '回放 C01';
  }
  const inputEl = document.querySelector('#input');
  if (inputEl) inputEl.placeholder = '也可以直接打字，回车送入';

  const banner = document.createElement('div');
  banner.className = 'sem-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  document.body.appendChild(banner);

  let ledger = new TranscriptLedger({ epoch: 1 });
  let store = new SemanticStore({ epoch: 1, ledger });
  let renderer = null;
  let scheduler = null;
  let presenter = null;
  let editing = null;
  let manualSeq = 0;
  let demoToken = 0;
  let latTimer = 0;

  const setBanner = (text, { retry = false } = {}) => {
    banner.textContent = '';
    banner.hidden = !text;
    if (!text) return;
    banner.append(document.createTextNode(text));
    if (retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试';
      btn.addEventListener('click', () => {
        banner.hidden = true;
        scheduler?.resume();
      });
      banner.append(btn);
    }
  };

  const status = (label) => {
    if (!liveLabel) return;
    liveLabel.textContent = STATUS_LABELS[label] || label || '等待输入';
  };

  const setLat = (text, warn = false) => {
    window.clearTimeout(latTimer);
    latTimer = window.setTimeout(() => {
      if (latEl) {
        latEl.textContent = text;
        latEl.classList.toggle('warn', warn);
      }
    }, 0);
  };

  const makeRenderer = () => {
    const r = new SemanticRenderer(deck);
    r.render(store.snapshot(), { animate: false, reason: 'boot' });
    return r;
  };

  const onEvent = (event) => {
    if (!event) return;
    if (event.kind === 'request_started') {
      status('理解中');
      if (latEl) latEl.textContent = '…';
    } else if (event.kind === 'degraded') {
      const reason = event.reason || 'unknown';
      if (reason === 'no_key') {
        status('未配置 Key');
        setBanner('没有可用的模型 Key：这里只记录并显示原话，不解释关系。', { retry: true });
      } else {
        status('理解失败');
        setBanner(`这次理解没有完成（${reason}）：画面保持上一次有效结果，原话仍在记录。`, {
          retry: true,
        });
      }
      if (latEl) latEl.textContent = '降级';
    } else if (event.kind === 'halt') {
      const reason = event.reason || 'halted';
      const pending = ledger.pendingCount();
      status('已暂停');
      setBanner(
        pending
          ? `语义理解已暂停（${reason}），还有 ${pending} 条原话未消费。修好后点重试。`
          : `语义理解已暂停（${reason}）。修好后点重试。`,
        { retry: true }
      );
      if (latEl) latEl.textContent = '暂停';
    } else if (event.kind === 'rejected' || event.kind === 'presenter_error') {
      if (latEl) latEl.textContent = '重算';
    }
  };

  const onCommit = (state, { markVisible, metrics }) => {
    const shown = presenter ? presenter.render(state, { animate: true, reason: 'commit' }) : renderer?.render(state, { animate: true, reason: 'commit' });
    if (metrics && Number.isFinite(metrics.latency_ms)) {
      setLat(`${(metrics.latency_ms / 1000).toFixed(2)}s`);
    }
    if (shown) {
      status('已更新');
      requestAnimationFrame(() => {
        try {
          markVisible();
        } catch {}
      });
    } else {
      status('已保持');
    }
    refreshHud();
  };

  const newScheduler = () =>
    new SemanticScheduler({
      store,
      ledger,
      onCommit,
      onEvent,
      // 记录最近一次原始响应，便于诊断“模型给了什么”，不落盘、不含 Key。
      fetchImpl: async (url, init) => {
        const res = await fetch(url, init);
        try {
          const text = await res.clone().text();
          window.__lastUnderstand = { at: Date.now(), status: res.status, body: text };
        } catch {}
        return res;
      },
    });

  const push = (event) => {
    const result = ledger.ingest({
      kind: 'transcript',
      epoch: ledger.epoch,
      ...event,
    });
    if (!result.ok || result.applied === false) {
      // 迟到 partial、过期 epoch 等属于预期拒绝：不打断画面，只留诊断。
      (window.__semanticRejects = window.__semanticRejects || []).push({
        event,
        code: result.code || 'rejected',
      });
    }
    return result;
  };

  const manual = (text) => {
    const value = String(text || '').trim();
    if (!value) return;
    manualSeq += 1;
    push({
      segment_id: `m${manualSeq}`,
      order: ledger.nextOrder(),
      revision: 1,
      phase: 'final',
      text: value,
    });
  };

  const reset = () => {
    demoToken += 1;
    scheduler?.stop({ abort: true });
    ledger.reset({ epoch: ledger.epoch + 1 });
    store.reset({ epoch: ledger.epoch });
    if (renderer) renderer.destroy();
    renderer = makeRenderer();
    presenter = new SemanticPresenter({
      store,
      renderer,
      onStatus: (kind) => {
        if (kind === 'held') status('已保持');
        else if (kind === 'resumed') status('已更新');
        else if (kind === 'pinned') status('回看中');
        else if (kind === 'unpinned') status('已更新');
        else if (kind === 'edited') status('人工更正');
        refreshHud();
      },
    });
    closeEditor();
    refreshHud();
    scheduler = newScheduler();
    scheduler.start();
    setBanner('');
    status('待机');
    if (latEl) latEl.textContent = '—';
    if (capEl) capEl.textContent = '';
    capWrap?.classList.remove('on');
    manualSeq = 0;
  };

  const demo = () => {
    reset();
    const token = demoToken;
    const base = performance.now();
    for (const item of C01_EVENTS) {
      const wait = Math.max(0, base + item.at_ms - performance.now());
      window.setTimeout(() => {
        if (token !== demoToken) return;
        push({
          segment_id: 'demo1',
          order: 1,
          revision: item.revision,
          phase: item.phase,
          text: item.text,
        });
        if (capEl) {
          capEl.textContent = item.text;
          capWrap?.classList.add('on');
          capWrap?.classList.toggle('interim', item.phase === 'partial');
        }
      }, wait);
    }
  };


  // ---- Presenter 控件：保持/恢复、有限历史回看、人工更正 ----
  const hud = document.createElement('div');
  hud.className = 'sem-hud';
  hud.setAttribute('role', 'toolbar');
  hud.setAttribute('aria-label', '画面控制');

  const holdBtn = document.createElement('button');
  holdBtn.type = 'button';
  holdBtn.className = 'sem-hud-btn sem-hold';
  holdBtn.setAttribute('aria-pressed', 'false');
  holdBtn.addEventListener('click', () => {
    if (!presenter) return;
    if (presenter.held) presenter.resume();
    else presenter.hold();
    refreshHud();
  });
  hud.appendChild(holdBtn);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'sem-hud-btn';
  backBtn.textContent = '回到当前';
  backBtn.hidden = true;
  backBtn.addEventListener('click', () => {
    presenter?.unpin();
    refreshHud();
  });
  hud.appendChild(backBtn);

  const sceneBar = document.createElement('div');
  sceneBar.className = 'sem-scenes';
  sceneBar.setAttribute('role', 'group');
  sceneBar.setAttribute('aria-label', '场景历史');
  hud.appendChild(sceneBar);

  const heldNote = document.createElement('span');
  heldNote.className = 'sem-held-note';
  hud.appendChild(heldNote);

  const unresolvedNote = document.createElement('button');
  unresolvedNote.type = 'button';
  unresolvedNote.className = 'sem-hud-btn sem-unresolved';
  unresolvedNote.hidden = true;
  hud.appendChild(unresolvedNote);
  document.body.appendChild(hud);

  const drawer = document.createElement('aside');
  drawer.className = 'sem-drawer';
  drawer.hidden = true;
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', '人工更正');
  const drawerTitle = document.createElement('h2');
  drawerTitle.className = 'sem-drawer-title';
  const drawerHint = document.createElement('p');
  drawerHint.className = 'sem-drawer-hint';
  drawerHint.textContent = '只修改这一处；不会重新解释整段话。';
  const labelField = document.createElement('label');
  labelField.className = 'sem-field';
  const labelText = document.createElement('span');
  labelText.textContent = '文字';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.maxLength = 28;
  labelField.append(labelText, labelInput);
  const claimField = document.createElement('label');
  claimField.className = 'sem-field';
  const claimText = document.createElement('span');
  claimText.textContent = '说法';
  const claimSelect = document.createElement('select');
  for (const [value, text] of [
    ['assertion', '陈述'],
    ['hypothesis', '设想'],
    ['question', '提问'],
    ['proposal', '提议'],
    ['quotation', '引用'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    claimSelect.appendChild(opt);
  }
  claimField.append(claimText, claimSelect);
  const relationField = document.createElement('label');
  relationField.className = 'sem-field';
  const relationText = document.createElement('span');
  relationText.textContent = '关系';
  const relationSelect = document.createElement('select');
  for (const [value, text] of [
    ['causes', '导致'],
    ['contrasts', '对比'],
    ['part_of', '组成'],
    ['converges_to', '汇入'],
    ['sequence', '随后'],
    ['conditional', '若'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    relationSelect.appendChild(opt);
  }
  relationField.append(relationText, relationSelect);
  const drawerError = document.createElement('p');
  drawerError.className = 'sem-drawer-error';
  drawerError.hidden = true;
  const drawerActions = document.createElement('div');
  drawerActions.className = 'sem-drawer-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '保存更正';
  const retractBtn = document.createElement('button');
  retractBtn.type = 'button';
  retractBtn.className = 'sem-danger';
  retractBtn.textContent = '撤回';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';
  drawerActions.append(saveBtn, retractBtn, closeBtn);
  drawer.append(drawerTitle, drawerHint, labelField, claimField, relationField, drawerError, drawerActions);
  document.body.appendChild(drawer);

  const closeEditor = () => {
    drawer.hidden = true;
    drawerError.hidden = true;
    retractBtn.textContent = '撤回';
    retractBtn.dataset.armed = 'false';
    editing = null;
  };
  closeBtn.addEventListener('click', closeEditor);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) {
      closeEditor();
      event.preventDefault();
    }
  });

  const showEditor = (kind, id) => {
    if (!presenter || presenter.held) {
      setBanner('先点“继续更新”，再更正画面。');
      return;
    }
    const state = store.snapshot();
    const model = kind === 'node' ? state.nodes[id] : state.edges[id];
    if (!model || model.state === 'retracted') return;
    editing = { kind, id };
    drawerTitle.textContent = kind === 'node' ? '更正这个对象' : '更正这条关系';
    labelText.textContent = kind === 'node' ? '文字' : '标签';
    labelInput.value = model.label || '';
    claimField.hidden = kind !== 'node';
    relationField.hidden = kind !== 'edge';
    if (kind === 'node') claimSelect.value = model.claim_kind || 'assertion';
    else relationSelect.value = model.relation || 'causes';
    drawerError.hidden = true;
    drawer.hidden = false;
    labelInput.focus();
    labelInput.select();
  };

  saveBtn.addEventListener('click', () => {
    if (!presenter || !editing) return;
    const label = labelInput.value.trim();
    const result =
      editing.kind === 'node'
        ? presenter.editNode(editing.id, { label, claim_kind: claimSelect.value })
        : presenter.editEdge(editing.id, { label, relation: relationSelect.value });
    if (!result.ok) {
      drawerError.textContent = (result.errors || [result.code || '更正失败']).join('；');
      drawerError.hidden = false;
      return;
    }
    closeEditor();
    refreshHud();
  });

  retractBtn.addEventListener('click', () => {
    if (!presenter || !editing) return;
    if (retractBtn.dataset.armed !== 'true') {
      retractBtn.dataset.armed = 'true';
      retractBtn.textContent = '再点一次撤回';
      return;
    }
    const result = presenter.retract(editing.id);
    if (!result.ok) {
      drawerError.textContent = (result.errors || [result.code || '撤回失败']).join('；');
      drawerError.hidden = false;
      return;
    }
    closeEditor();
    refreshHud();
  });

  deck.addEventListener('click', (event) => {
    const el = event.target.closest?.('[data-sem-id]');
    if (!el || !deck.contains(el)) return;
    const kind = el.classList.contains('sem-edge') ? 'edge' : 'node';
    showEditor(kind, el.getAttribute('data-sem-id'));
  });
  deck.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target.closest?.('[data-sem-id]');
    if (!el) return;
    event.preventDefault();
    showEditor(el.classList.contains('sem-edge') ? 'edge' : 'node', el.getAttribute('data-sem-id'));
  });

  function refreshHud() {
    if (!presenter) return;
    const state = store.snapshot();
    const scenes = Object.values(state.scenes).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const recent = scenes.slice(-5);
    sceneBar.textContent = '';
    for (const scene of recent) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sem-scene-chip';
      btn.dataset.scene = scene.id;
      btn.textContent = scene.title || '未命名场景';
      btn.classList.toggle('is-current', scene.id === state.active_scene_id);
      btn.classList.toggle('is-pinned', scene.id === presenter.pinnedSceneId);
      btn.title = scene.id === state.active_scene_id ? '当前场景' : '回看这个场景（显式回看才会切换画面）';
      btn.addEventListener('click', () => {
        if (scene.id === state.active_scene_id) presenter.unpin();
        else presenter.pin(scene.id);
        refreshHud();
      });
      sceneBar.appendChild(btn);
    }
    sceneBar.hidden = scenes.length === 0;
    holdBtn.textContent = presenter.held ? '继续更新' : '保持画面';
    holdBtn.setAttribute('aria-pressed', presenter.held ? 'true' : 'false');
    holdBtn.disabled = scenes.length === 0;
    backBtn.hidden = !presenter.pinned;
    document.body.classList.toggle('sem-held', presenter.held);
    heldNote.textContent = presenter.held
      ? `已保持 · 后台继续（${ledger.pendingCount()} 条待处理）`
      : presenter.pinned
        ? '正在回看；新理解不会切走当前场景'
        : '';
    const unresolved = state.unresolved || [];
    unresolvedNote.hidden = unresolved.length === 0;
    if (unresolved.length) {
      unresolvedNote.textContent = `未决 ${unresolved.length}`;
      unresolvedNote.title = unresolved.map((u) => u.text || u.reason || '').filter(Boolean).join(' / ');
    }
  }

  renderer = makeRenderer();
  presenter = new SemanticPresenter({
    store,
    renderer,
    onStatus: (kind) => {
      if (kind === 'held') status('已保持');
      else if (kind === 'resumed') status('已更新');
      else if (kind === 'pinned') status('回看中');
      else if (kind === 'unpinned') status('已更新');
      else if (kind === 'edited') status('人工更正');
      refreshHud();
    },
  });
  refreshHud();
  scheduler = newScheduler();
  scheduler.start();
  status('待机');

  window.__semanticDebug = {
    get ledger() {
      return ledger;
    },
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    get renderer() {
      return renderer;
    },
    get presenter() {
      return presenter;
    },
    get diagnostics() {
      return scheduler?.diagnostics || null;
    },
    push,
    demo,
  };

  return {
    push,
    manual,
    reset,
    demo,
    status,
    get diagnostics() {
      return scheduler?.diagnostics || null;
    },
  };
}
