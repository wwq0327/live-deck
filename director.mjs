// 导演：把「最近说的话 + 当前页」变成一条舞台指令。
// 有 DEEPSEEK_API_KEY 就走真模型（thinking 关掉，~0.7s）；没有就用本地启发式兜底。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DIRECTOR_MODEL || 'deepseek-flash';

const LAYOUTS = new Set(['title', 'bullets', 'bigidea', 'stat', 'compare', 'steps', 'quote']);

export function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const s = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = s.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/);
    if (m) return m[1];
  } catch {}
  return null;
}

const SYSTEM = `你是现场"视觉导演"，不是 PPT 生成器。演讲者正在讲话，你负责让大屏上的画面跟上他。
输入：最近的转写（含口头禅和错字）、当前屏幕上的页。
输出：一条指令，决定"换一页 / 补一行 / 不动"。

只输出 JSON，不要解释，不要 markdown。字段：
{
  "action": "new_slide" | "patch" | "noop",
  "layout": "title" | "bullets" | "bigidea" | "stat" | "compare" | "steps" | "quote",
  "kicker": "2-6 字的栏目名，可空",
  "title": "主标题，<=16 字，像人话，有节奏",
  "subtitle": "补充一句，<=28 字，可空",
  "points": ["<=16 字"],
  "left":  {"label": "<=6 字", "value": "<=14 字"},
  "right": {"label": "<=6 字", "value": "<=14 字"},
  "stat":  {"value": "1.2", "unit": "秒", "label": "<=16 字"},
  "steps": ["<=14 字"],
  "quote": {"text": "<=40 字", "by": "<=10 字"},
  "accent": "#RRGGBB",
  "add_points": ["<=16 字"]
}

判断规则：
1. 只抓主张、数字、对比、因果、结论；口头禅、语气词、重复全部丢掉。
2. 只要最近一句带来了新信息（新数字、新对比、新结论、新例子、新转折），就必须出页：话题没变 → patch（列表补一行）；话题切换 / 新例子 / 转折 / 出现数字 → new_slide。
3. noop 只留给三种情况：纯口头禅、对上一句的原样重复、明显没说完的半句。不要因为"主题一样"就 noop。
4. 一屏最多 3 行字，超了就换页重讲，不要硬塞。
5. 布局：有明确数字 → stat；两者对照 → compare；步骤/顺序 → steps；一句话金句 → bigidea 或 quote；列举 → bullets；开场点题 → title。
6. title 不是目录项，是能被念出来的一句话。不要写"关于……的思考"这种。
7. accent 用深色背景上醒目的颜色，同一主题保持相近色系。
8. 转写可能有同音错字（份/粉、生成/声称、页/业、PPT/TTT），写页面文字时按上下文改对，不要照抄错字。
9. 画的是「刚说的最后一句」。前面的话已经上过屏了，不要拿它再出一页；last 之外的转写只用来理解代词、补全主语。
10. 如果当前页被标成「临时草稿」，说明它是占位用的，可以整页重写，不用考虑跟它保持一致。
11. 别每次都只给 title + subtitle。这句话里有两个以上并列的东西，就给 points（每条 <=12 字）；讲过程/顺序，就给 steps（2–4 步）；讲到数字，就给 stat 或 stats；讲到"以前 vs 现在"，就给 left/right。字段给全一点，页面才撑得起来。
12. 一页只讲一件事。宁可少写，不要堆。

示例 1
转写：「以前做一份演示要三四个小时，现在大概一分钟。」
输出 {"action":"new_slide","layout":"compare","kicker":"对比","title":"从三小时到一分钟","left":{"label":"以前","value":"三四个小时"},"right":{"label":"现在","value":"一分钟"},"accent":"#FF5A2B"}

示例 2
转写：「对，然后呢，我们其实还做了一个小东西，就是那个，让它可以跟着说话走。」
输出 {"action":"new_slide","layout":"bigidea","kicker":"核心","title":"让画面跟着话走","subtitle":"不是做完再讲，是边讲边长出来","accent":"#FF5A2B"}`;

function userPrompt({ transcript, current, mode }) {
  const all = String(transcript || '');
  const tail = all.slice(-900);
  const parts = tail.split(/[。！？!?\n]/).map((x) => x.trim()).filter(Boolean);
  const last = parts.pop() || tail;
  const before = parts.slice(-3).join('。');
  const cur = current
    ? current.provisional
      ? `当前页：临时草稿（占位，允许整页重写）：${JSON.stringify({ layout: current.layout, title: current.title })}`
      : `当前页：${JSON.stringify({ layout: current.layout, title: current.title, points: current.points })}`
    : '当前页：无（还没开场）';
  if (mode === 'predict') {
    return `${cur}\n刚才说过的（背景，不要重复画）：「${before}」\n刚说的这一句：「${last}」\n\n演讲者还没说下一句。根据上文预判他接下来最可能讲什么，输出那一页。`;
  }
  return `${cur}\n刚才说过的（背景，不要重复画）：「${before || '（还没有）'}」\n刚说的这一句：「${last}」\n\n这一句该显示什么？`;
}

export async function callDirector({ transcript, current, mode = 'decide' }) {
  const key = loadKey();
  const t0 = Date.now();
  if (!key) return { ...heuristic({ transcript, current }), ms: Date.now() - t0, source: 'heuristic' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt({ transcript, current, mode }) },
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' }, // 关键：关掉思考链，否则单次 2s+
        temperature: mode === 'predict' ? 0.9 : 0.65,
        max_tokens: 400,
      }),
    });
    if (!r.ok) throw new Error(`api ${r.status}`);
    const j = await r.json();
    const raw = j.choices?.[0]?.message?.content ?? '';
    const slide = normalize(JSON.parse(stripFence(raw)), current);
    return { ...slide, ms: Date.now() - t0, source: 'model', model: MODEL };
  } catch (e) {
    return { ...heuristic({ transcript, current }), ms: Date.now() - t0, source: 'fallback', error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function stripFence(s) {
  return String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

function normalize(raw, current) {
  const SL = ['title', 'bullets', 'bigidea', 'stat', 'compare', 'steps', 'quote'];
  let action = ['new_slide', 'patch', 'noop'].includes(raw.action) ? raw.action : 'new_slide';
  let layout = SL.includes(raw.layout) ? raw.layout : 'bigidea';
  const out = {
    action,
    layout,
    kicker: clip(raw.kicker, 8),
    title: clip(raw.title, 20),
    subtitle: clip(raw.subtitle, 34),
    points: Array.isArray(raw.points) ? raw.points.map((p) => clip(p, 20)).filter(Boolean).slice(0, 3) : [],
    steps: Array.isArray(raw.steps) ? raw.steps.map((p) => clip(p, 18)).filter(Boolean).slice(0, 3) : [],
    accent: /^#[0-9a-fA-F]{6}$/.test(raw.accent || '') ? raw.accent : (current?.accent || '#FF5A2B'),
    add_points: Array.isArray(raw.add_points) ? raw.add_points.map((p) => clip(p, 20)).filter(Boolean).slice(0, 2) : [],
  };
  if (raw.left?.value) out.left = { label: clip(raw.left.label, 8), value: clip(raw.left.value, 16) };
  if (raw.right?.value) out.right = { label: clip(raw.right.label, 8), value: clip(raw.right.value, 16) };
  if (raw.stat?.value) out.stat = { value: clip(String(raw.stat.value), 8), unit: clip(raw.stat.unit, 4), label: clip(raw.stat.label, 20) };
  if (raw.quote?.text) out.quote = { text: clip(raw.quote.text, 48), by: clip(raw.quote.by, 12) };

  if (action === 'patch' && !out.add_points.length) action = 'noop';
  if (action !== 'noop' && !out.title && !out.stat?.value && !out.quote?.text) action = 'noop';
  out.action = action;
  return out;
}

/* ---------- 无 Key 时的兜底：够用的规则导演 ---------- */

const ACCENTS = ['#FF5A2B', '#FFB454', '#6EE7B7', '#7C9CFF', '#FF6B9D', '#C6F24E'];

function lastSentence(t) {
  const s = String(t || '').split(/[。！？!?\n]/).map((x) => x.trim()).filter(Boolean);
  return s[s.length - 1] || '';
}

function heuristic({ transcript }) {
  const s = lastSentence(transcript);
  const pick = [...transcript].length % ACCENTS.length;
  const accent = ACCENTS[pick];
  const num = s.match(/(\d+(?:\.\d+)?)\s*(%|秒|分钟|小时|倍|个|人|天|年|万|亿)?/);

  if (num && /[0-9]/.test(s)) {
    return {
      action: 'new_slide',
      layout: 'stat',
      kicker: '数字',
      title: clip(s.replace(num[0], ''), 20),
      stat: { value: num[1], unit: num[2] || '', label: clip(s, 20) },
      accent,
    };
  }
  if (/对比|相比|以前|过去|现在|反而|但是/.test(s)) {
    return {
      action: 'new_slide',
      layout: 'compare',
      kicker: '对比',
      title: clip(s, 20),
      left: { label: '以前', value: '慢' },
      right: { label: '现在', value: '快' },
      accent,
    };
  }
  if (/第一|第二|第三|首先|然后|最后|步骤/.test(s)) {
    return { action: 'new_slide', layout: 'steps', kicker: '路径', title: clip(s, 20), steps: ['听', '想', '画'], accent };
  }
  if ([...s].length <= 18) {
    return { action: 'new_slide', layout: 'bigidea', kicker: '一句', title: clip(s, 20), accent };
  }
  return {
    action: 'new_slide',
    layout: 'bullets',
    kicker: '展开',
    title: clip(s.split(/[，,]/)[0], 20),
    points: s.split(/[，,；;]/).map((x) => x.trim()).filter(Boolean).slice(0, 3).map((x) => clip(x, 20)),
    accent,
  };
}
