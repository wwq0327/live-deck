// ?mode=semantic 的浏览器入口：账本 → 调度 → Store → 稳定渲染。
// 输入仍由 stage.js 现有的麦克风/VAD/ASR 管线提供，这里不复制第二套采集。
import { TranscriptLedger } from './transcript.js';
import { SemanticStore } from './store.js';
import { SemanticScheduler } from './scheduler.js';
import { SemanticRenderer } from './renderer.js';

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
    renderer?.render(state, { animate: true, reason: 'commit' });
    if (metrics && Number.isFinite(metrics.latency_ms)) {
      setLat(`${(metrics.latency_ms / 1000).toFixed(2)}s`);
      status('已更新');
    }
    requestAnimationFrame(() => {
      try {
        markVisible();
      } catch {}
    });
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

  renderer = makeRenderer();
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
