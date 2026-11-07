// 舞台：渲染、动效、口播字幕、导演往返
const $ = (s) => document.querySelector(s);
const deck = $('#deck');
const glow = $('#glow');
const latEl = $('#lat');
const liveEl = $('#live');
const liveLabel = $('#live-label');
const idxEl = $('#idx');
const capEl = $('#cap');
const capWrap = $('#caption');
const micBtn = $('#mic');
const demoBtn = $('#demo');
const inputEl = $('#input');

const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview');
const CLEAN = params.get('clean') === '1';
const AUTOPLAY = params.get('autoplay') === '1';
if (CLEAN) document.body.classList.add('clean');

const DEFAULT_ACCENT = '#FF5A2B';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fit() {
  const s = Math.min(innerWidth / 1600, innerHeight / 900);
  document.documentElement.style.setProperty('--s', s.toFixed(4));
}
addEventListener('resize', fit);
fit();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 版式 ---------- */


/* ---------- 图形符号（内联 SVG，无外部资源） ---------- */
const GLYPHS = {
  spark: '<path d="M12 2.6c.42 4.7 1.4 5.7 6 6.1-4.6.42-5.58 1.4-6 6.1-.42-4.7-1.4-5.68-6-6.1 4.6-.42 5.58-1.4 6-6.1Z" fill="currentColor" stroke="none"/><circle cx="19" cy="19" r="2" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2 5 13.4h5.4L11 22l8-11.4h-5.4L13 2Z"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.3V12l3.2 2"/>',
  chart: '<path d="M4 19.2h16"/><path d="M7.2 19.2V11M12 19.2V5.8M16.8 19.2v-5.4"/>',
  users: '<circle cx="9" cy="8.4" r="3.2"/><path d="M3.6 19.4c0-3 2.4-4.8 5.4-4.8s5.4 1.8 5.4 4.8"/><path d="M16.2 5.7a3 3 0 0 1 0 5.8"/><path d="M17.6 14.9c1.9.5 3 2 3 4.5"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2.6"/><path d="M10 3.6v3M14 3.6v3M10 17.4v3M14 17.4v3M3.6 10h3M3.6 14h3M17.4 10h3M17.4 14h3"/>',
  layers: '<path d="M12 3.2 3.7 7.6 12 12l8.3-4.4L12 3.2Z"/><path d="m3.7 12.4 8.3 4.4 8.3-4.4"/><path d="m3.7 16.8 8.3 4.4 8.3-4.4"/>',
  wave: '<path d="M3 12h2.2M7.2 7.4v9.2M10.8 4.4v15.2M14.4 8.4v7.2M18 5.8v12.4M21.4 10.4v3.2"/>',
  bulb: '<path d="M9.4 17.2h5.2M10.4 20.4h3.2"/><path d="M12 3.2a6 6 0 0 0-3.6 10.8c.6.5.9 1.2.9 2h5.4c0-.8.3-1.5.9-2A6 6 0 0 0 12 3.2Z"/>',
  target: '<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="4.3"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  grid: '<rect x="4" y="4" width="6.4" height="6.4" rx="1.7"/><rect x="13.6" y="4" width="6.4" height="6.4" rx="1.7"/><rect x="4" y="13.6" width="6.4" height="6.4" rx="1.7"/><rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1.7"/>',
  arrow: '<path d="M4 12h15"/><path d="m13.4 6.4 6 5.6-6 5.6"/>',
};
const svgIcon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${
    GLYPHS[name] || GLYPHS.spark
  }</svg>`;

const GLYPH_RULES = [
  [/(幻灯片|演示|版面|页面|版式|PPT|讲稿)/, 'layers'],
  [/(模型|智能|算法|芯片|AI|机器学习|大模型)/, 'chip'],
  [/(实时|延迟|秒|速度|更快|很快|瞬间|时间差)/, 'bolt'],
  [/(小时|分钟|周期|一年|一天|耗时)/, 'clock'],
  [/(增长|一倍|倍数|效率|数据|提升|转化)/, 'chart'],
  [/(用户|团队|大家|每个人|观众|听众)/, 'users'],
  [/(模型|智能|算法|芯片|AI|机器学习)/, 'chip'],
  [/(幻灯片|演示|结构|页面|版式|PPT)/, 'layers'],
  [/(声音|口播|语音|说话|开口|听|讲)/, 'wave'],
  [/(想法|创意|灵感|点子|主意)/, 'bulb'],
  [/(关键|核心|本质|重点|难点)/, 'target'],
  [/(工具|流程|系统|管线|步骤|方法)/, 'grid'],
];
function pickGlyph(...texts) {
  for (const t of texts.filter(Boolean)) {
    for (const [re, g] of GLYPH_RULES) if (re.test(t)) return g;
  }
  return 'spark';
}

/* 版式派生：模型只负责说什么，视觉变体在本地决定，不增加一次调用 */
const RECENT = [];

function shape(points) {
  const pts = (points || []).map((x) => String(x).trim()).filter(Boolean);
  if (!pts.length) return null;
  const max = Math.max(...pts.map((p) => p.length));
  return { n: pts.length, max };
}

// 防重排不能只换模板：目标模板要能承载当前内容，必要时补字段。
function canAlt(L, s) {
  if (L === 'quote' || L === 'compare' || L === 'stat' || L === 'stats') return null;
  const alt = {
    hero: 'band', band: 'split', split: 'splitflip', splitflip: 'hero',
    cards: 'chips', chips: 'cards', bullets: 'steps', steps: 'bullets',
    title: s.subtitle ? 'split' : 'band',
  }[L];
  if (!alt) return null;
  const ptsList = s.points || [];
  const stepsList = s.steps || [];
  const pts = ptsList.length;
  const steps = stepsList.length;
  if (alt === 'steps') {
    if (!steps && !pts) return null;
    if (pts) s.steps = [...stepsList, ...ptsList].slice(0, 3);
  } else if (alt === 'bullets' || alt === 'cards' || alt === 'chips') {
    if (!pts && !steps) return null;
    if (steps) s.points = [...stepsList, ...ptsList].slice(0, 3);
  } else if (!s.title && !pts && !s.subtitle) {
    return null;
  }
  return alt;
}

function derive(s, settle) {
  const out = { ...s };
  if (out.pinned) { out.skin = out.skin || 'dark'; return out; }
  const pts = (out.points || []).map(String).filter(Boolean);
  out.points = pts;
  const sh = shape(pts);

  // 1) 先按"内容的形状"决定最合适的版式
  let L = out.layout;
  if (L === 'bullets' || L === 'cards') {
    if (sh && sh.n >= 2 && sh.max <= 8) L = 'chips';
    else if (sh && sh.n >= 2 && sh.n <= 4 && sh.max <= 15) L = 'cards';
    else if (sh) L = 'bullets';
    else L = 'hero';
  }
  if (L === 'stat' || L === 'stats') {
    const list = Array.isArray(out.stats) && out.stats.length
      ? out.stats
      : (out.stat ? [out.stat] : []);
    if (list.length >= 2) {
      L = 'stats';
      out.stats = list.slice(0, 3);
    } else if (list.length === 1) {
      L = 'stat';
      out.stat = list[0];
    } else {
      // 模型说要画数字，却没给 stat/stats：别留一张空页，退回能装下这句话的版式
      if (sh && sh.n >= 2 && sh.n <= 4) L = 'cards';
      else if (sh) L = 'bullets';
      else L = 'hero';
    }
  }
  if (L === 'title') {
    if (!out.subtitle) L = String(out.title || '').length <= 20 ? 'hero' : 'title';
    else if (state.n > 0) L = state.n % 2 ? 'split' : 'band';
  }
  if (L === 'bigidea') L = 'hero';

  // 2) 避免连续两页同一个版式（这是"看起来都一样"的主因）
  const prev = settle ? RECENT[RECENT.length - 2] : RECENT[RECENT.length - 1];
  const alt = prev === L ? canAlt(L, out) : null;
  if (alt) L = alt;
  // 连续三页都是"一句话"时，逼一版结构化的
  if (RECENT.length >= 2 && RECENT.every((x) => x === 'hero' || x === 'title' || x === 'band') && (L === 'hero' || L === 'title' || L === 'band')) {
    if (sh && sh.n >= 2) L = sh.max <= 8 ? 'chips' : 'cards';
    else if (out.steps?.length >= 2) L = 'steps';
    else if (out.left && out.right) L = 'compare';
  }
  // 2.4) 有副标题的句子：大字/分栏/色块轮着来，别总是"一行大字 + 一行小字"
  if (out.subtitle && (L === 'hero' || L === 'title') && state.n > 0) {
    L = ['split', 'band', 'hero'][state.n % 3];
  }

  // 2.5) 本地小规则：把"从 X 到 Y""以前/现在"这类句子直接变成对比页
  if ((L === 'hero' || L === 'title') && !out.left && !out.right) {
    const m = String(out.title || '').match(/从(.{2,12}?)到(.{2,12})/);
    if (m) {
      L = 'compare';
      out.left = { label: '以前', value: m[1] };
      out.right = { label: '现在', value: m[2] };
    }
  }

  out.layout = L;
  if (L === 'splitflip') out.flip = true;

  // 3) 底色：三种，按节奏交替，别一黑到底
  const n = state.n;
  if (out.skin) {
    // 模型显式指定就听
  } else if (L === 'stat' || L === 'stats' || L === 'quote') {
    out.skin = 'wash';
  } else if (n % 4 === 2) {
    out.skin = 'cream';
  } else if (n % 7 === 5) {
    out.skin = 'wash';
  } else {
    out.skin = 'dark';
  }
  if (out.noInvert) out.skin = 'dark';

  // 4) 图形：hero/band/split 都给一个符号，别让页面空着
  if (!out.art && (L === 'hero' || L === 'band' || L === 'split' || L === 'splitflip')) {
    out.art = pickGlyph(out.title, ...(out.points || []));
  }

  if (DEBUG) window.__recent = RECENT.slice();
  if (settle && RECENT.length) RECENT[RECENT.length - 1] = L;
  else RECENT.push(L);
  if (RECENT.length > 3) RECENT.shift();
  return out;
}

function layoutHTML(s) {
  const k = (d) => (s.kicker ? `<div class="kicker anim" style="--d:${d}">${esc(s.kicker)}</div>` : '');
  const h1 = (d, cls = '') =>
    s.title ? `<h1 class="clip ${cls}" style="--d:${d}"><span>${esc(s.title)}</span></h1>` : '';
  const h2 = (d) =>
    s.title ? `<h2 class="clip" style="--d:${d}"><span>${esc(s.title)}</span></h2>` : '';
  const ghost = () => `<div class="ghost">${svgIcon(s.art || 'layers')}</div>`;

  switch (s.layout) {
    case 'hero':
      return `${ghost()}${k(0)}${h1(100)}
        ${s.subtitle ? `<p class="sub anim" style="--d:300">${esc(s.subtitle)}</p>` : '<div class="rule" style="--d:320"></div>'}`;

    case 'band':
      return `${ghost()}
        <div class="band anim" style="--d:0">
          ${s.kicker ? `<div class="kicker">${esc(s.kicker)}</div>` : ''}
          ${s.title ? `<h1 class="clip" style="--d:120"><span>${esc(s.title)}</span></h1>` : ''}
          ${s.subtitle ? `<p class="sub" style="--d:280">${esc(s.subtitle)}</p>` : ''}
        </div>`;

    case 'cards':
      return `${k(0)}${s.title ? `<h2 class="clip" style="--d:70"><span>${esc(s.title)}</span></h2>` : ''}
        <div class="grid" style="--cols:${Math.min(4, Math.max(2, (s.points || []).length))}">
          ${(s.points || [])
            .map(
              (p, i) =>
                `<div class="card anim" style="--d:${180 + i * 90}">
                   <div class="ico">${svgIcon(pickGlyph(p))}</div>
                   <div class="n">0${i + 1}</div>
                   <div class="t">${esc(p)}</div>
                 </div>`
            )
            .join('')}
        </div>`;

    case 'chips':
      return `${k(0)}${h1(90)}
        <div class="chips">
          ${(s.points || [])
            .map((p, i) => `<span class="chip anim" style="--d:${200 + i * 80}">${esc(p)}</span>`)
            .join('')}
        </div>`;

    case 'split':
    case 'splitflip':
      return `<div class="pane anim ${s.flip ? 'l' : 'r'}" style="--d:120">
          <div class="g">${svgIcon(s.art || pickGlyph(s.title))}</div>
        </div>
        <div class="half">
          ${k(0)}${h2(80)}
          ${s.subtitle ? `<p class="sub anim" style="--d:260">${esc(s.subtitle)}</p>` : ''}
          ${(s.points || []).slice(0, 3).map((p, i) => `<div class="mini anim" style="--d:${320 + i * 80}">${esc(p)}</div>`).join('')}
        </div>`;

    case 'bullets':
      return `${k(0)}${h2(90)}<ul>${(s.points || [])
        .map(
          (p, i) =>
            `<li class="anim" style="--d:${190 + i * 80}"><b>0${i + 1}</b><span>${esc(p)}</span></li>`
        )
        .join('')}</ul>`;

    case 'stat': {
      const one = (Array.isArray(s.stats) && s.stats[0]) || s.stat || {};
      const value = String(one.value ?? '');
      const fs = value.length > 6 ? Math.max(180, 300 - (value.length - 6) * 30) : 300;
      return `${k(0)}
        <div class="stat-row">
          <span class="num anim" style="--d:90;--fs:${fs}px">${esc(value)}</span>
          <span class="unit anim" style="--d:210">${esc(one.unit ?? '')}</span>
        </div>
        <div class="stat-label anim" style="--d:300">${esc(one.label ?? '')}</div>
        ${s.title ? `<div class="stat-ctx anim" style="--d:380">${esc(s.title)}</div>` : ''}`;
    }

    case 'stats':
      return `${k(0)}${h2(70)}
        <div class="stats">${(s.stats || [])
          .slice(0, 3)
          .map((st, i) => {
            const value = String(st.value ?? '');
            const unit = String(st.unit || '');
            const span = value.length + unit.length * 0.55;
            const fs = span > 3 ? Math.max(64, 168 - (span - 3) * 18) : 168;
            return `<div class="statc anim" style="--d:${140 + i * 110}">
                 <div class="v" style="--fs:${fs}px">${esc(value)}<i>${esc(unit)}</i></div>
                 <div class="lb">${esc(st.label || '')}</div>
               </div>`;
          })
          .join('')}</div>`;

    case 'compare': {
      const valFs = (v) => {
        const n = String(v || '').length;
        return n > 10 ? Math.max(38, 54 - (n - 10) * 4) : 54;
      };
      const fs = Math.min(valFs(s.left?.value), valFs(s.right?.value));
      return `${k(0)}${h2(90)}
        <div class="cols">
          <div class="col anim" style="--d:200">
            <div class="label">${esc(s.left?.label ?? '')}</div>
            <div class="value" style="--fs:${fs}px">${esc(s.left?.value ?? '')}</div>
          </div>
          <div class="vs anim" style="--d:300">vs</div>
          <div class="col anim" style="--d:340">
            <div class="label">${esc(s.right?.label ?? '')}</div>
            <div class="value" style="--fs:${fs}px">${esc(s.right?.value ?? '')}</div>
          </div>
        </div>`;
    }

    case 'steps':
      return `${k(0)}${h2(90)}
        <div class="steps">${(s.steps || [])
          .map(
            (t, i) =>
              `<div class="step anim" style="--d:${200 + i * 90}"><i></i><div class="n">0${i + 1}</div><div class="t">${esc(t)}</div></div>`
          )
          .join('')}</div>`;

    case 'quote':
      return `${k(0)}
        <div class="mark anim" style="--d:60">“</div>
        <blockquote class="anim" style="--d:150">${esc(s.quote?.text ?? s.title ?? '')}</blockquote>
        ${s.quote?.by ? `<div class="by anim" style="--d:300">${esc(s.quote.by)}</div>` : ''}`;

    case 'title':
      return `${k(0)}${h1(110)}${s.subtitle ? `<p class="sub anim" style="--d:240">${esc(s.subtitle)}</p>` : ''}`;

    default:
      return `${k(0)}${h1(110)}`;
  }
}

const state = { transcript: '', current: null, history: [], n: 0, busy: false, pending: [], spec: null, ahead: null, live: null, seg: 0, listening: false };
let epoch = 0;
let pageSeq = 0;

const DEBUG = params.get('debug') === '1';
if (DEBUG) window.__d = { get recent() { return RECENT.slice(); }, get state() { return state; } };
const dbg = (...a) => { if (DEBUG || window.__keepLog) (window.__log = window.__log || []).push(a.join(' ')); };

const slideClass = (slide) =>
  `slide l-${slide.layout || 'title'} skin-${slide.skin || 'dark'}${slide.flip ? ' flip' : ''}`;

const flat = (x) => String(x || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function show(raw, opts = {}) {
  if (!raw) return;
  // 同一句话被 VAD 切成两段时，别翻出一模一样的两页
  const cur = state.current;
  if (!opts.force && cur && cur.title && raw.title && flat(cur.title) === flat(raw.title)) {
    dbg('show->morph', flat(raw.title).slice(0, 12));
    return morph(raw, { lockPoints: true });
  }
  const slide = derive(raw, false);
  const blank =
    !slide.title && !(slide.points || []).length && !(slide.steps || []).length &&
    !slide.stat && !(slide.stats || []).length && !slide.quote && !slide.left;
  if (blank) {
    slide.title = lastSentence(slide.text || state.transcript || '').slice(0, 26) || '…';
    slide.layout = 'hero';
    if (!slide.skin || slide.skin === 'cream') slide.skin = 'dark';
  }
  const n = state.n;
  slide.pageId = ++pageSeq;
  const el = document.createElement('section');
  el.dataset.pageId = String(slide.pageId);
  el.className = slideClass(slide);
  el.style.setProperty('--accent', slide.accent || DEFAULT_ACCENT);
  el.innerHTML = layoutHTML(slide);
  glow.style.background = slide.accent || DEFAULT_ACCENT;

  const old = deck.querySelector('.slide');
  if (old) {
    old.classList.add('out');
    setTimeout(() => old.remove(), 420);
  }
  deck.appendChild(el);
  document.body.dataset.skin = slide.skin || 'dark';
  dbg('show', n, slide.layout, slide.title, state.live ? 'live' : '-');

  if (state.current) state.history.push(state.current);
  state.current = slide;
  state.n += 1;
  idxEl.textContent = String(state.n).padStart(2, '0');
  return el;
}

/* 就地改写当前这一页：说话过程中页面跟着话长，而不是一页一页翻 */
function morph(next, opts = {}) {
  const cur = opts.base || state.current;
  if (!cur || !next) return;
  const targetId = opts.targetId;
  const el = targetId
    ? deck.querySelector(`.slide[data-page-id="${targetId}"]`)
    : [...deck.querySelectorAll('.slide')].pop();
  if (!el) return;
  const young = state.live ? performance.now() - state.live.t0 < 2400 : false;
  const layout = opts.forceLayout || young ? next.layout || cur.layout : cur.layout;
  const slide = derive({ ...cur, ...next, layout }, true);
  slide.points = opts.lockPoints && (cur.points || []).length > (next.points || []).length ? cur.points : slide.points;
  if (!targetId || state.current?.pageId === slide.pageId) state.current = slide;
  if (state.live && state.live.slide?.pageId === slide.pageId) state.live.slide = slide;
  el.className = slideClass(slide) + ' soft';
  document.body.dataset.skin = slide.skin || 'dark';
  dbg('morph', state.n - 1, slide.layout, slide.title);
  el.style.setProperty('--accent', slide.accent || DEFAULT_ACCENT);
  el.innerHTML = layoutHTML(slide);
  glow.style.background = slide.accent || DEFAULT_ACCENT;
}

const mergePoints = (cur, add) => {
  const pts = [...(cur?.points || [])];
  for (const p of add || []) if (!pts.includes(p) && pts.length < 4) pts.push(p);
  return pts.length !== (cur?.points || []).length ? pts : null;
};

/* ---------- 字幕 ---------- */

let capTimer = 0;
function caption(text, mode = 'final') {
  capEl.textContent = text || '';
  capWrap.classList.toggle('on', Boolean(text));
  capWrap.classList.toggle('interim', mode === 'interim');
  clearTimeout(capTimer);
  if (mode === 'final') capTimer = setTimeout(() => capWrap.classList.remove('on'), 2000);
  if (mode === 'hold') capTimer = 0;
}

/* ---------- 导演 ---------- */

const inflight = new Set();

async function askDirect(mode, transcript, purpose, currentOverride, onPartial) {
  const cur =
    currentOverride !== undefined
      ? currentOverride
      : state.current && !state.current.standby
        ? state.current
        : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  inflight.add(ctrl);
  const stream = typeof onPartial === 'function';
  try {
    const r = await fetch(stream ? '/api/direct/stream' : '/api/direct', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transcript: transcript || state.transcript,
        current: cur,
        mode,
        purpose,
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!stream) return await r.json();
    if (!r.body) throw new Error('stream body missing');
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'partial') {
          try { onPartial(ev); } catch {}
        } else if (ev.type === 'done') {
          result = ev.result;
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'stream error');
        }
      }
    }
    if (!result) throw new Error('stream ended without result');
    return result;
  } finally {
    clearTimeout(timer);
    inflight.delete(ctrl);
  }
}

const bigrams = (s) => {
  const t = [...String(s).replace(/[\s，。！？、,.!?：:；;]/g, '')];
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t[i] + t[i + 1]);
  return set;
};
function overlap(a, b) {
  const A = bigrams(a);
  let n = 0;
  for (const x of bigrams(b)) if (A.has(x)) n++;
  return n;
}
const lastSentence = (t) =>
  String(t || '').split(/[。！？!?\n]/).map((x) => x.trim()).filter(Boolean).pop() || '';

const same = (a, b) => a && b && a.layout === b.layout && a.title === b.title;

async function commit(text, t0, snapshot) {
  text = String(text || '').trim();
  if (!text) return;
  state.transcript = (state.transcript + ' ' + text).trim();
  caption(text, 'final');
  if (state.busy) {
    // 不覆盖：连续输入排队，按顺序各处理一次；每条记住自己的文本快照。
    state.pending.push({ t0, snapshot, text, transcript: state.transcript });
    return;
  }
  // 没有活页、也没有可复用的快照：先本地上一页，别让首屏空等模型。
  if (!state.live && !snapshot) {
    provisional(text);
    if (state.live) snapshot = state.live;
  }
  await decide(t0, snapshot, undefined, text, state.transcript);
}

async function decide(startedAt, snapshot, expectedEpoch, textOverride, transcriptOverride) {
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) return;
  const myEpoch = epoch;
  state.busy = true;
  liveEl.classList.add('thinking');
  liveLabel.textContent = '思考';
  const t0 = startedAt || performance.now();
  try {
    const seed = lastSentence(textOverride || transcriptOverride || state.transcript);
    const live = snapshot !== undefined ? snapshot : state.live;
    // 旧句子的 final 不能写到已经开始的下一句页上。
    if (live && live.slide?.pageId && state.current?.pageId !== live.slide.pageId) {
      dbg('decide dropped', 'stale page', live.slide.title);
      return;
    }
    const cur = live && live.local ? { ...(live.slide || {}), provisional: true } : undefined;
    let streamed = false;
    const res = await askDirect('decide', transcriptOverride || state.transcript, undefined, cur, (ev) => {
      if (myEpoch !== epoch || !ev.title) return;
      // 只有已经绑定到这一句的活页才接受流式标题；没有活页时不能
      // 把新句子的半个标题写到上一页上（排队句尤其明显）。
      if (!live?.slide?.pageId || state.current?.pageId !== live.slide.pageId) return;
      const el = deck.querySelector(`.slide[data-page-id="${live.slide.pageId}"]`);
      if (!el) return;
      const h = el.querySelector('h1,h2');
      if (!h) return;
      const span = h.querySelector('.clip > span') || h;
      span.textContent = ev.title;
      streamed = true;
    });
    if (myEpoch !== epoch) return;
    if (live?.slide?.pageId && state.current?.pageId !== live.slide.pageId) {
      dbg('decide dropped', 'page moved', live.slide.title);
      return;
    }
    let instant = false;
    dbg('decide', res.action, res.title, live ? (live.local ? 'local' : 'live') : 'none');

    // 这一句已经边说边出了一页：收句只做定稿，不再另起一页
    if (live && live.slide) {
      if (live.local && res.action === 'new_slide') {
        // 本地先上的临时页：模型说什么就换成什么
        morph({ ...res, noInvert: false, skin: res.skin || undefined }, { forceLayout: true, targetId: live.slide.pageId, base: live.slide });
        instant = true;
      } else if (res.action === 'new_slide' && (topicNear(res.title, live.slide.title) || topicNear(res.title, seed))) {
        morph(res, { lockPoints: true, targetId: live.slide.pageId, base: live.slide });
        instant = true;
      } else if (res.action === 'new_slide') {
        show(res); // 话题换了才翻页
      } else if (res.action === 'patch') {
        const pts = mergePoints(state.current, res.add_points);
        if (pts) morph({ ...state.current, points: pts });
        instant = true;
      } else {
        instant = true;
      }
      state.ahead = null;
      const fromLocal = Boolean(live.local);
      const src = res.source === 'fallback' || res.source === 'heuristic'
        ? res.source
        : (fromLocal ? (res.source || 'model') : (instant ? 'ahead' : res.source));
      const showInstant = instant && !fromLocal;
      setLat(showInstant ? 0 : Math.round(performance.now() - t0), showInstant, src, res.error);
      // 定稿完成：这一页不再“边说边长”，下一句应该另起一页。
      if (state.live === live) state.live = null;
      return;
    }

    // 没有活页（短句、第一句、或者模型还没来得及回）
    if (state.spec && state.spec.slide?.action === 'new_slide' && overlap(state.spec.seed, seed) >= 3) {
      show(state.spec.slide);
      instant = true;
      state.spec = null;
    }
    if (state.ahead && state.ahead.slide?.action === 'new_slide') {
      const flat = (x) => String(x || '').replace(/[\s，。！？、,.!?：:；;""'']/g, '');
      const pt = flat(state.ahead.text);
      const fd = flat(seed);
      const grew = pt.length >= 6 && (fd.startsWith(pt) || pt.startsWith(fd));
      const cov = bigrams(pt).size ? overlap(pt, fd) / bigrams(pt).size : 0;
      if ((grew || cov >= 0.85) && !same(state.ahead.slide, state.current)) {
        show(state.ahead.slide);
        instant = true;
        window.__aheadUsed = (window.__aheadUsed || 0) + 1;
      }
      state.ahead = null;
    }
    if (res.action === 'new_slide' && (!same(res, state.current) || streamed)) {
      show(res);
    } else if (res.action === 'patch' && state.current?.layout === 'bullets') {
      const pts = mergePoints(state.current, res.add_points);
      if (pts) show({ ...state.current, points: pts });
    }
    const src = res.source === 'fallback' || res.source === 'heuristic' ? res.source : (instant ? 'ahead' : res.source);
    setLat(instant ? 0 : Math.round(performance.now() - t0), instant, src, res.error);
    state.spec = null;
  } catch (err) {
    if (myEpoch !== epoch) return;
    // 请求失败时这一页还没定稿：清掉活页/预判，下一句重新起页，避免在旧页上原地改写。
    state.live = null;
    state.ahead = null;
    liveLabel.textContent = '掉线';
    setLat(0, false, 'error', err?.message);
  } finally {
    if (myEpoch === epoch) {
      state.busy = false;
      liveEl.classList.remove('thinking');
      liveLabel.textContent = demoRunning ? '演示' : state.listening ? '听' : '待机';
      if (state.pending.length) {
        const p = state.pending.shift();
        // 排队句按“新起一页”处理，不能拿上一句的活页快照去 morph 当前页。
        await decide(p.t0, null, myEpoch, p.text, p.transcript);
      } else {
        speculate();
      }
    }
  }
}

// ---- 边说边出：部分转写一到就先上屏，模型结果回来再原地改 ----
let aheadBusy = false;

const PICK = ['#FF5A2B', '#FFB454', '#6EE7B7', '#7C9CFF', '#FF6B9D', '#C6F24E'];
const pickAccent = () => PICK[(state.n + 1) % PICK.length];

// 本地立刻给一页（不等模型），先让画面动起来
function provisional(text) {
  dbg('prov?', state.live ? 'has' : 'none', state.busy ? 'busy' : 'idle', text.slice(0, 12));
  if (state.live || state.busy) return;
  const t = String(text).replace(/[，。！？、,.!?：:；;\s]+$/, '').trim();
  if (t.length < 8) return;
  // 占位页按页序轮换构图：别每句都长成一个样
  const kind = ['bigidea', 'title', 'bigidea', 'split'][state.n % 4];
  show({
    layout: kind,
    kicker: '实时',
    title: t.length > 22 ? t.slice(0, 22) + '…' : t,
    subtitle: '',
    art: kind === 'split' ? pickGlyph(t) : '',
    accent: pickAccent(),
    standby: false,
    noInvert: true,
  });
  state.live = { t0: performance.now(), slide: state.current, local: true };
  window.__prov = (window.__prov || 0) + 1;
  setLat(0, true, 'local');
}

function applyAhead(text, r) {
  if (!r || r.action !== 'new_slide' || !r.title) return;
  const live = state.live;
  dbg('ahead->', live ? (live.local ? 'local' : 'live') : 'none', r.title);
  if (!live) {
    const el = show(r);
    state.live = { t0: performance.now(), slide: state.current };
    setLat(0, true, 'ahead');
    return;
  }
  const near =
    live.local ||
    topicNear(r.title, live.slide?.title) ||
    topicNear(r.title, text) ||
    performance.now() - live.t0 < 2400;
  if (!near) return;
  morph({ ...r, noInvert: false }, { forceLayout: live.local });
  live.local = false;
  setLat(Math.round(performance.now() - live.t0) + 0, true, 'ahead');
}

async function prethink(partialText) {
  const t = String(partialText || '').trim();
  if (t.length < 8 || aheadBusy) return;
  const myEpoch = epoch;
  const seg = state.seg;
  aheadBusy = true;
  try {
    const r = await askDirect(
      'decide',
      (state.transcript + ' ' + t).trim(),
      'ahead',
      state.current && !state.current.standby ? { ...state.current, provisional: true } : null
    );
    if (myEpoch !== epoch || seg !== state.seg) { dbg('ahead dropped', t.slice(0, 8)); return; }
    if (r.action === 'new_slide' && r.title) {
      state.ahead = { text: t, slide: r };
      applyAhead(t, r);
      window.__aheadSet = (window.__aheadSet || 0) + 1;
    }
  } catch {}
  finally {
    if (myEpoch === epoch) aheadBusy = false;
  }
}

const topicNear = (a, b) => {
  const A = String(a || ''), B = String(b || '');
  if (!A || !B) return false;
  return overlap(A, B) >= 2 || A.includes(B.slice(0, 6)) || B.includes(A.slice(0, 6));
};

window.morphDebug = () => ({ live: Boolean(state.live), n: state.n, title: state.current?.title });
if (DEBUG) window.__deckDebug = { derive, layoutHTML, show, morph, state, RECENT, commit };

async function speculate() {
  if (!state.current || state.busy || aheadBusy || state.ahead) return;
  const myEpoch = epoch;
  const seed = lastSentence(state.transcript);
  try {
    const r = await askDirect('predict');
    if (myEpoch !== epoch) return;
    if (r.action === 'new_slide' && r.title) state.spec = { seed, slide: r };
  } catch {}
}

function setLat(ms, instant, source, error) {
  latEl.title = '';
  latEl.classList.remove('warn');
  if (source === 'error') {
    latEl.textContent = '导演掉线';
    latEl.classList.remove('hit');
    latEl.title = error || '导演接口不可用';
    return;
  }
  if (source === 'fallback' || source === 'heuristic') {
    latEl.textContent = source === 'fallback' ? '规则兜底' : '本地规则';
    latEl.classList.remove('hit');
    latEl.classList.toggle('warn', source === 'fallback');
    latEl.title = error || (source === 'fallback' ? '导演模型不可用，已用本地规则' : '没有找到 Key，使用本地规则');
    return;
  }
  latEl.textContent = instant ? '0.00s · 预生成' : `${(ms / 1000).toFixed(2)}s`;
  latEl.classList.toggle('hit', Boolean(instant));
}

/* ---------- 麦克风：本地 whisper ---------- */

const SR = 16000;
const CLOSE_MS = 0.42;
let mic = null;
let micToken = 0;
let pendingPartial = null;
let partialCtrl = null;
const asrInflight = new Set();
const vad = {
  active: false, seg: [], segLen: 0, pre: [], preLen: 0,
  silence: 0, voiced: 0, noise: 0.004,
  partialText: '', partialLen: 0, partialAt: 0,
};

const setLive = (t) => { liveLabel.textContent = t || '待机'; };
const concat = (list) => {
  let n = 0;
  for (const c of list) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
};

function clearVad() {
  vad.active = false;
  vad.seg = []; vad.segLen = 0;
  vad.pre = []; vad.preLen = 0;
  vad.silence = 0; vad.voiced = 0; vad.noise = 0.004;
  vad.partialText = ''; vad.partialLen = 0; vad.partialAt = 0;
}

function float32ToWav(f32, sr) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buf;
}

function resample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.max(0, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    const a = input[i0] ?? 0, b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function postAudio(f32, mode, signal) {
  const res = await fetch('/api/asr?mode=' + mode, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'audio/wav' },
    body: float32ToWav(f32, SR),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function firePartial() {
  const audio = concat(vad.seg);
  if (audio.length < SR * 1.0) return; // 太短的片段转出来多半是错字
  const len = audio.length;
  const myEpoch = epoch;
  const ctrl = new AbortController();
  partialCtrl = ctrl;
  asrInflight.add(ctrl);
  const job = postAudio(audio, 'partial', ctrl.signal)
    .then((r) => {
      if (myEpoch !== epoch || !vad.active) return;
      if (r.text && r.text.trim().length >= 6) {
        vad.partialText = r.text;
        vad.partialLen = len;
        vad.partialAt = performance.now();
        caption(r.text, 'interim');
        provisional(r.text);
        prethink(r.text);
      }
    })
    .catch(() => {})
    .finally(() => {
      asrInflight.delete(ctrl);
      if (partialCtrl === ctrl) partialCtrl = null;
      if (pendingPartial === job) pendingPartial = null;
    });
  pendingPartial = job;
}

// 收句时 partial 只是“预览”：不能再让 final 排在它后面等。
function cancelPartial() {
  if (partialCtrl) {
    partialCtrl.abort();
    partialCtrl = null;
  }
  pendingPartial = null;
}

async function finishSegment(audio, t0, snapshot) {
  const myEpoch = epoch;
  cancelPartial();
  if (myEpoch !== epoch) return;
  vad.partialText = '';
  vad.partialLen = 0;
  vad.partialAt = 0;

  setLive('转写');
  const ctrl = new AbortController();
  asrInflight.add(ctrl);
  try {
    const r = await postAudio(audio, 'final', ctrl.signal);
    if (myEpoch !== epoch) return;
    if (r.text) commit(r.text, t0, snapshot);
    else caption('（这句没听清，再说一次）', 'hold');
  } catch (err) {
    if (myEpoch !== epoch) return;
    caption('本地转写失败：' + err.message, 'hold');
  } finally {
    asrInflight.delete(ctrl);
    if (myEpoch === epoch && !state.busy) setLive(state.listening ? '听' : '待机');
  }
}

function closeSegment() {
  dbg('close', Math.round(vad.segLen / SR * 10) / 10 + 's');
  const t0 = performance.now();
  const snapshot = state.live;
  state.live = null;
  state.ahead = null;
  state.seg += 1; // 让还没回来的 partial/prethink 立即过期
  vad.active = false;
  cancelPartial();
  const f = concat(vad.seg);
  const keep = Math.max(0, f.length - vad.silence);
  const audio = f.subarray(0, keep);
  vad.seg = []; vad.segLen = 0; vad.silence = 0; vad.voiced = 0;
  if (audio.length / SR < 0.45) return;
  finishSegment(audio, t0, snapshot);
}

let playToken = 0;

async function feedFile(file) {
  const token = ++playToken;
  if (mic) stopMic();
  caption('正在解码这段录音…', 'hold');
  try {
    const buf = await file.arrayBuffer();
    if (token !== playToken) return;
    const ac = new AudioContext();
    const dec = await ac.decodeAudioData(buf);
    if (token !== playToken) { ac.close(); return; }
    const ch = Math.min(2, dec.numberOfChannels);
    const len = dec.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = dec.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dec.duration * SR)), SR);
    const b = off.createBuffer(1, len, dec.sampleRate || SR);
    b.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = b;
    src.connect(off.destination);
    src.start();
    const out = (await off.startRendering()).getChannelData(0);
    try { ac.close(); } catch {}
    if (token !== playToken) return;
    if ($('#diag').classList.contains('on')) closeDiag();
    state.listening = true;
    setLive('听');
    caption('拿录音跑一遍：' + file.name + '（1.5 倍速，切句和出页跟麦克风一模一样）', 'hold');
    await playBuffer(out, token);
  } catch (e) {
    if (token === playToken) caption('这个文件解不开：' + e.message, 'hold');
  }
}

function playBuffer(data, token = playToken) {
  return new Promise((resolve) => {
    const step = 2048;
    let i = 0;
    const tick = () => {
      if (token !== playToken) { resolve(); return; }
      if (i >= data.length) {
        if (vad.active) closeSegment();
        state.listening = false;
        setLive('待机');
        resolve();
        return;
      }
      processChunk(data.subarray(i, i + step));
      i += step;
      setTimeout(tick, ((step / SR) * 1000) / 1.5);
    };
    tick();
  });
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) feedFile(f);
});

function processChunk(chunk) {
  const n = chunk.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / n);
  const thr = Math.max(0.012, vad.noise * 2.8);

  if (rms < thr && !vad.active) vad.noise = vad.noise * 0.97 + rms * 0.03;

  vad.pre.push(chunk);
  vad.preLen += n;
  while (vad.preLen > SR * 0.4 && vad.pre.length > 1) {
    vad.preLen -= vad.pre[0].length;
    vad.pre.shift();
  }

  if (rms >= thr) {
    vad.silence = 0;
    if (!vad.active) {
      vad.voiced += n;
      if (vad.voiced >= SR * 0.1) {
        vad.active = true;
        vad.seg = vad.pre.slice();
        vad.segLen = vad.preLen;
        vad.partialText = '';
        vad.partialLen = 0;
        vad.partialAt = 0;
        state.ahead = null;
        state.live = null;
        state.seg += 1;
        setLive('听');
      }
    } else {
      vad.seg.push(chunk);
      vad.segLen += n;
    }
  } else {
    vad.voiced = 0;
    if (vad.active) {
      vad.silence += n;
      vad.seg.push(chunk);
      vad.segLen += n;
      if (vad.silence >= SR * CLOSE_MS) closeSegment();
    }
  }

  // 20 秒上限必须独立于静音判断：连续有声时也要能收句。
  if (vad.active && vad.segLen > SR * 20) closeSegment();

  // 已经在静音尾部时别再发新 partial：收句马上就到，发了也只会挡住 final。
  if (
    vad.active &&
    vad.silence < SR * 0.15 &&
    vad.segLen > SR * 0.9 &&
    !pendingPartial &&
    performance.now() - vad.partialAt > 700
  ) {
    firePartial();
  }
}

if (DEBUG) Object.assign(window.__deckDebug, { processChunk, clearVad, vad });

async function startMic() {
  if (mic) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return failMic(null);
  }
  const token = ++micToken;
  let stream = null;
  let ctx = null;
  const discard = () => {
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (token !== micToken) { discard(); return; }
    ctx = new AudioContext({ sampleRate: SR });
    await ctx.resume();
    if (token !== micToken) { discard(); return; }
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
    if (token !== micToken) { discard(); return; }
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const rate = ctx.sampleRate;
    node.port.onmessage = (e) => {
      if (token !== micToken) return;
      const chunk = rate === SR ? e.data : resample(e.data, rate, SR);
      processChunk(chunk);
    };
    src.connect(node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);

    mic = { stream, ctx, node, src };
    state.listening = true;
    micBtn.classList.add('on');
    closeDiag();
    setLive('听');
    caption('本地模型在听。说完一句停一下，画面就来。', 'final');
  } catch (err) {
    if (token !== micToken) { discard(); return; }
    discard();
    failMic(err);
  }
}

const DIAG_HINT = {
  NotAllowedError: '权限被拒（浏览器或系统层面）',
  NotFoundError: '系统里找不到麦克风设备',
  NotReadableError: '麦克风被别的程序占着（会议软件里常见）',
  SecurityError: '这个地址不被信任，浏览器不给用麦克风',
  AbortError: '打开被中断了，重试一次',
};

async function failMic(err) {
  const rows = [];
  const push = (k, v) => rows.push([k, String(v)]);
  push('错误', err ? err.name + (err.message ? ' · ' + err.message : '') : 'navigator.mediaDevices 不存在');
  push('含义', err ? (DIAG_HINT[err.name] || '未知') : '不是安全上下文，浏览器彻底关掉了麦克风 API');
  push('地址', location.href);
  push('安全上下文', isSecureContext ? '是' : '否 —— 必须用 http://127.0.0.1 或 https 打开');
  push('在 iframe 里', self !== window.top ? '是 —— 外层页面可能禁掉了麦克风' : '否');
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    push('浏览器权限', p.state === 'granted' ? '已允许' : p.state === 'denied' ? '已阻止' : '没问过');
  } catch { push('浏览器权限', '查不到（Safari 不支持）'); }
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    push('输入设备', ds.filter((d) => d.kind === 'audioinput').length + ' 个');
  } catch {}
  renderDiag(rows);
}

let diagReturnFocus = null;

function renderDiag(rows) {
  const box = document.getElementById('diag');
  if (!box) return;
  diagReturnFocus = document.activeElement;
  box.querySelector('#diag-rows').innerHTML = rows
    .map(([k, v]) => '<div><b>' + esc(k) + '</b><span>' + esc(v) + '</span></div>')
    .join('');
  box.classList.add('on');
  box.setAttribute('aria-hidden', 'false');
  const x = document.getElementById('diag-x');
  if (x) x.focus();
  caption('麦克风打不开，下面写了原因和三步修法。', 'hold');
}

function closeDiag() {
  const box = document.getElementById('diag');
  if (!box || !box.classList.contains('on')) return;
  box.classList.remove('on');
  box.setAttribute('aria-hidden', 'true');
  if (diagReturnFocus && document.contains(diagReturnFocus)) {
    try { diagReturnFocus.focus(); } catch {}
  }
  diagReturnFocus = null;
}

function stopMic() {
  micToken += 1;
  const m = mic;
  mic = null;
  clearVad();
  state.listening = false;
  micBtn.classList.remove('on');
  setLive('待机');
  if (!m) return;
  try { m.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { m.node.disconnect(); m.ctx.close(); } catch {}
}

micBtn.addEventListener('click', () => (mic ? stopMic() : startMic()));
$('#diag-x').addEventListener('click', closeDiag);
$('#diag-retry').addEventListener('click', () => { closeDiag(); startMic(); });
$('#diag').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDiag(); return; }
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ---------- 打字 ---------- */

function submitText() {
  const v = inputEl.value.trim();
  if (!v) return;
  inputEl.value = '';
  commit(v);
}
$('#go').addEventListener('click', submitText);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitText();
});

/* ---------- 演示 ---------- */

const DEMO = [
  '大家好，今天我想聊一个很小的想法：让 PPT 跟着你说话。',
  '以前做一份演示，要花三四个小时，画图，排版，调字号。',
  '但你真正想说的话，其实在开口的那几分钟里就已经有了。',
  '所以我们做了一个东西，它一边听你说，一边把画面画出来。',
  '从你说完一句话，到屏幕上出现一页，大概一秒。',
  '它不追求好看，它追求跟上你。',
  '第一步，把语音变成文字。第二步，一个小模型决定这页长什么样。第三步，模板填空。',
  '关键不是生成，是节奏：什么时候换页，什么时候只补一行字。',
  '这就是我们想要的：你讲到哪，画面就跟到哪。',
];

let demoRunning = false;
let demoToken = 0;

function stopDemo() {
  demoToken += 1;
  demoRunning = false;
  demoBtn.classList.remove('on');
  if (!state.busy) liveLabel.textContent = state.listening ? '听' : '待机';
}

async function typeOut(line, token) {
  const chars = [...line];
  const per = Math.max(26, Math.min(64, 2600 / chars.length));
  for (let i = 1; i <= chars.length; i++) {
    if (token !== demoToken) return false;
    caption(chars.slice(0, i).join(''), 'interim');
    await sleep(per);
  }
  return token === demoToken;
}

async function runDemo() {
  if (demoRunning) { stopDemo(); return; }
  const token = ++demoToken;
  demoRunning = true;
  reset({ keepDemo: true });
  demoBtn.classList.add('on');
  liveLabel.textContent = '演示';
  for (const line of DEMO) {
    if (token !== demoToken) return;
    if (!await typeOut(line, token)) return;
    await commit(line);
    if (token !== demoToken) return;
    await sleep(500);
  }
  if (token !== demoToken) return;
  demoBtn.classList.remove('on');
  liveLabel.textContent = '待机';
  demoRunning = false;
}

demoBtn.addEventListener('click', runDemo);

/* ---------- 其它 ---------- */

function reset({ keepDemo = false } = {}) {
  if (!keepDemo) stopDemo();
  stopMic();
  epoch += 1;
  playToken += 1;
  for (const c of inflight) c.abort();
  inflight.clear();
  for (const c of asrInflight) c.abort();
  asrInflight.clear();
  pendingPartial = null;
  partialCtrl = null;
  aheadBusy = false;
  liveEl.classList.remove('thinking');

  state.transcript = '';
  state.current = null;
  state.history = [];
  state.spec = null;
  state.ahead = null;
  state.busy = false;
  state.pending = [];
  state.live = null;
  state.n = 0;
  state.seg = 0;
  state.listening = false;
  RECENT.length = 0;
  clearVad();
  micBtn.classList.remove('on');
  setLive('待机');

  idxEl.textContent = '00';
  deck.innerHTML = '';
  latEl.textContent = '—';
  latEl.classList.remove('hit');
  caption('');
}

$('#reset').addEventListener('click', () => {
  reset();
  standby();
});

function standby() {
  show({
    standby: true,
    layout: 'title',
    kicker: 'Live Deck',
    title: '开始说话，画面就跟上',
    subtitle: '点下面的麦克风，或直接打字。演示按钮会跑一段四十秒的样本。',
    accent: DEFAULT_ACCENT,
  });
}

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'm') micBtn.click();
  if (k === 'd') demoBtn.click();
  if (k === 'r') { reset(); standby(); }
  if (k === 'f') document.documentElement.requestFullscreen?.();
  if (k === 'h') document.body.classList.toggle('clean');
});

let idleTimer = 0;
addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3200);
});

/* ---------- 预览 / 自动演示 ---------- */

const SAMPLE = {
  title: {
    layout: 'title', kicker: 'Live Deck',
    title: '你讲到哪，画面就跟到哪',
    subtitle: '一个把语音变成现场画面的小实验',
    accent: '#FF5A2B',
  },
  bullets: {
    layout: 'bullets', kicker: '三步', title: '它其实只做三件事',
    points: ['听：把话变成字', '想：决定这页长什么样', '画：模板填空，立刻上屏'],
    accent: '#FF5A2B',
  },
  bigidea: {
    layout: 'bigidea', kicker: '核心', title: '不是做完再讲，是边讲边长出来',
    accent: '#7C9CFF',
  },
  stat: {
    layout: 'stat', kicker: '延迟', title: '从说完一句到页面出现',
    stat: { value: '1.2', unit: '秒', label: '端到端，含模型与动画' },
    accent: '#FFB454',
  },
  compare: {
    layout: 'compare', kicker: '对比', title: '从三小时到一分钟',
    left: { label: '以前', value: '三四个小时' },
    right: { label: '现在', value: '一分钟' },
    accent: '#6EE7B7',
  },
  steps: {
    layout: 'steps', kicker: '管线', title: '一条直线，没有 agent',
    steps: ['流式转写', '小模型决策', '模板渲染'],
    accent: '#FF6B9D',
  },
  quote: {
    layout: 'quote', kicker: '一句',
    quote: { text: '真正难的不是生成，是什么时候换页。', by: '做的时候才明白' },
    accent: '#C6F24E',
  },
  cards: {
    layout: 'cards', kicker: '三件事', title: '它其实只做三件事',
    points: ['听：把话变成字', '想：决定这页长什么样', '画：模板填空'],
    accent: '#FF5A2B',
  },
  split: {
    layout: 'split', kicker: '核心', title: '让 PPT 跟着你说话',
    subtitle: '你说完一句，它就知道该画什么',
    art: 'wave',
    accent: '#7C9CFF',
  },
  invert: {
    layout: 'bullets', kicker: '反面', title: '不是做完再讲',
    points: ['先说，再说一遍', '页面跟着话长', '停下来才定稿'],
    accent: '#FF5A2B', skin: 'cream',
  },
  hero: {
    layout: 'hero', kicker: '核心', title: '边讲边长出来',
    art: 'spark', accent: '#7C9CFF',
  },
  band: {
    layout: 'band', kicker: '贴纸', title: '一句话就能换一页',
    subtitle: '页面不是想出来的，是跟着嘴长出来的',
    art: 'layers', accent: '#C6F24E', skin: 'dark',
  },
  chips: {
    layout: 'chips', kicker: '关键词', title: '今天讲三件事',
    points: ['语音', '转写', '决策', '模板', '动效', '延迟'],
    accent: '#FF5A2B',
  },
  stats: {
    layout: 'stats', kicker: '数字', title: '一晚上做出来的',
    stats: [
      { value: '1.5', unit: '秒', label: '开口到第一页' },
      { value: '0.1', unit: '秒', label: '一句转写' },
      { value: '13', unit: '套', label: '版式模板' },
    ],
    accent: '#FFB454',
  },
  splitflip: {
    layout: 'splitflip', kicker: '分栏', title: '左边说话，右边出图',
    subtitle: '图形由关键词决定，不用画',
    points: ['听见', '判断', '上屏'],
    art: 'chip', accent: '#6EE7B7',
  },
  wash: {
    layout: 'stat', kicker: '泼色', title: '满版色也能用',
    stat: { value: '43', unit: '%', label: '预判命中率' },
    accent: '#FF6B9D', skin: 'wash',
  },
};

if (PREVIEW) {
  document.body.classList.add('clean');
  show({ ...(SAMPLE[PREVIEW] || SAMPLE.title), pinned: true });
} else {
  standby();
  if (AUTOPLAY) setTimeout(runDemo, 500);
  else if (params.get('mic') === '1') setTimeout(startMic, 300);
}
