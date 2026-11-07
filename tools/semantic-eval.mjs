#!/usr/bin/env node
// 真实 Flash 语义质量评测（C01—C08）。不进入 CI，显式运行才调用付费接口。
//
//   node tools/semantic-eval.mjs --reps 3
//
// 输出 docs/evaluations/2026-11-07-semantic/eval-<timestamp>.json，并在 stdout 打印汇总。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, buildRequest } from '../test/helpers/semantic.mjs';
import { understand } from '../semantic-director.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test/fixtures/semantic');
const OUT_DIR = path.join(ROOT, 'docs/evaluations/2026-11-07-semantic');

const CASES = {
  C01: {
    title: '分散存储导致来回切换与耗时',
    edges: [
      { from: /(分散|微信|文档|表格)/, to: /(切换|找东西)/, relation: 'causes' },
      { from: /(切换|找东西)/, to: /(时间|耗时|花更多)/, relation: 'causes' },
    ],
    core: [/(分散|微信|文档|表格)/, /切换/, /(时间|耗时|花更多)/],
    forbid: [],
  },
  C02: {
    title: '否定纠正不能被删掉',
    edges: [],
    allowed: [
      {
        from: /(办法|方法)/,
        to: /减少切换/,
        relation: 'contrasts',
        when: (e) => /(不能|无法|不会|没有)/.test(e.label || ''),
      },
    ],
    core: [/(办法|方法)/, /(不能|无法|不会|没有)/, /减少切换|少切换/],
    forbid: [
      {
        label: '把“不能减少切换”写成正向能力',
        test: (g) =>
          g.nodes.some((n) => /(?<!不)能减少切换/.test(n.label) && n.state !== 'retracted') ||
          g.edges.some((e) => /(?<!不)能减少切换/.test(e.label || '')),
      },
    ],
  },
  C03: {
    title: '修正原因并限定人群',
    edges: [{ from: /(复杂|找不到入口|入口)/, to: /流失/, relation: 'causes' }],
    allowed: [
      { from: /(老用户)/, to: /(新用户|找不到入口)/, relation: 'contrasts' },
      { from: /(新用户|找不到入口)/, to: /(老用户|复杂)/, relation: 'contrasts' },
      { from: /(复杂|操作)/, to: /(新用户|找不到入口)/, relation: 'converges_to' },
      { from: /(新用户|找不到入口)/, to: /(复杂|操作)/, relation: 'contrasts' },
    ],
    core: [/流失/, /(复杂|找不到入口)/, /新用户/, /老用户/],
    forbid: [
      { label: '把老用户也写成流失', test: (g) => g.nodes.some((n) => /老用户/.test(n.label) && /(流失|受影响)/.test(n.label) && n.state !== 'retracted') },
    ],
  },
  C04: {
    title: '先后不等于因果，保留不确定',
    edges: [],
    core: [/(换界面|界面)/, /(用户增长|增长)/, /(不确定|不能确定|关系不明|没有关系)/],
    forbid: [
      {
        label: '把“先换界面后增长”画成已确认因果',
        test: (g) =>
          g.edges.some(
            (e) =>
              e.relation === 'causes' &&
              e.state === 'supported' &&
              /(换界面|界面)/.test(labelOf(g, e.from)) &&
              /(增长)/.test(labelOf(g, e.to)),
          ),
      },
    ],
  },
  C05: {
    title: '问句/假设不能画成已确认原因',
    edges: [],
    core: [/(价格|定价)/, /流失/],
    forbid: [
      {
        label: '把价格问句画成已确认因果',
        test: (g) =>
          g.edges.some(
            (e) =>
              e.relation === 'causes' &&
              e.state === 'supported' &&
              /(价格|定价)/.test(labelOf(g, e.from)) &&
              /流失/.test(labelOf(g, e.to)),
          ),
      },
    ],
    check: (g) => ({ pass: g.nodes.some((n) => n.claim_kind === 'question' || /[?？]|会不会/.test(n.label)), detail: '需要 question 状态的节点' }),
    extraCore: (g) => [g.nodes.some((n) => n.claim_kind === 'question' || /[?？]|会不会/.test(n.label))],
  },
  C06: {
    title: '提议与待验证，不虚构效果',
    edges: [],
    core: [/(统一入口|入口)/, /(减少切换|切换)/, /(试|验证|待|还不|需要)/],
    forbid: [
      { label: '虚构百分比效果', test: (g) => g.nodes.some((n) => /\d+(\.\d+)?\s*%/.test(n.label)) },
      { label: '把提议写成已提高效率', test: (g) => g.nodes.some((n) => /(已|明显)?(提高|提升|减少)了?(效率|切换)/.test(n.label) && n.state === 'supported' && n.claim_kind === 'assertion') },
    ],
    check: (g) => ({ pass: g.nodes.some((n) => n.claim_kind === 'proposal' || /我想|希望/.test(n.label)), detail: '需要 proposal 状态的节点' }),
  },
  C07: {
    title: '旧判断被修正，旧原因被排除',
    edges: [{ from: /(新入口|入口)/, to: /(访问|增长)/, relation: 'causes' }],
    allowed: [
      { from: /(速度|以前)/, to: /(理解内容|后来)/, relation: 'contrasts' },
      { from: /(理解内容)/, to: /(速度)/, relation: 'contrasts' },
      { from: /(低价|价格)/, to: /(访问|增长)/, relation: 'contrasts' },
      { from: /(低价|价格)/, to: /(新入口|入口)/, relation: 'contrasts' },
    ],
    core: [/速度/, /理解内容/, /(新入口|入口)/, /(低价|价格)/],
    forbid: [
      {
        label: '把低价写成增长原因',
        test: (g) =>
          g.edges.some(
            (e) =>
              e.relation === 'causes' &&
              e.state === 'supported' &&
              /(低价|价格)/.test(labelOf(g, e.from)) &&
              /(增长|访问)/.test(labelOf(g, e.to)),
          ),
      },
      { label: '没有区分旧判断与当前判断', test: (g) => !g.nodes.some((n) => /速度/.test(n.label)) || !g.nodes.some((n) => /理解内容/.test(n.label)) },
    ],
  },
  C08: {
    title: '保留概数，不伪造精确值',
    edges: [],
    core: [/几万/, /几千/, /几十/],
    forbid: [{ label: '把概数写成精确数字', test: (g) => g.nodes.some((n) => /\d+\s*(万|千|百)/.test(n.label)) }],
  },
};

function labelOf(graph, id) {
  return graph.nodes.find((n) => n.id === id)?.label || '';
}

function snapshotOf(store) {
  const state = store.snapshot();
  const nodes = Object.values(state.nodes).filter((n) => n.state !== 'retracted');
  const edges = Object.values(state.edges).filter((e) => e.state !== 'retracted');
  const scenes = Object.values(state.scenes);
  return { nodes, edges, scenes, active: state.active_scene_id, unresolved: state.unresolved };
}

function scoreCase(spec, graph) {
  const semanticEdges = graph.edges.filter(
    (e) => ['causes', 'contrasts', 'part_of', 'converges_to'].includes(e.relation) && e.state === 'supported',
  );
  const tentativeEdges = graph.edges.filter(
    (e) => ['causes', 'contrasts', 'part_of', 'converges_to'].includes(e.relation) && e.state !== 'supported',
  );
  const matched = new Set();
  let required = 0;
  for (const gold of spec.edges) {
    required += 1;
    const hit = semanticEdges.find(
      (e) =>
        e.relation === gold.relation &&
        gold.from.test(labelOf(graph, e.from)) &&
        gold.to.test(labelOf(graph, e.to)),
    );
    if (hit) matched.add(hit.id);
  }
  const extra = semanticEdges.filter((e) => !matched.has(e.id));
  const coverage = spec.core.map((re) => {
    const inNode = graph.nodes.some((n) => re.test(n.label) || re.test(n.claim_kind || ''));
    const inEdge = graph.edges.some((e) => re.test(e.label || ''));
    const inUnresolved = graph.unresolved.some((u) => re.test(u.text || ''));
    return { re: String(re), pass: inNode || inEdge || inUnresolved };
  });
  const violations = [];
  for (const f of spec.forbid) {
    try {
      if (f.test(graph)) violations.push(f.label);
    } catch (err) {
      violations.push(`检查异常：${f.label} (${err.message})`);
    }
  }
  let extraCheck = null;
  if (spec.check) {
    try {
      extraCheck = spec.check(graph);
    } catch (err) {
      extraCheck = { pass: false, detail: err.message };
    }
  }
  const extraCoverage = (spec.extraCore?.(graph) || []).map((pass, i) => ({ re: `extra#${i}`, pass }));
  const allCoverage = [...coverage, ...extraCoverage];
  const allowedIds = new Set();
  for (const e of graph.edges) {
    const ok = (spec.allowed || []).some(
      (a) =>
        e.relation === a.relation &&
        a.from.test(labelOf(graph, e.from)) &&
        a.to.test(labelOf(graph, e.to)) &&
        (!a.when || a.when(e)),
    );
    if (ok) allowedIds.add(e.id);
  }
  const allowed = allowedIds.size;
  return {
    required,
    matched: matched.size,
    allowed: allowed,
    extraEdges: extra.map((e) => `${labelOf(graph, e.from)} -${e.relation}-> ${labelOf(graph, e.to)}`),
    tentativeEdges: tentativeEdges.map((e) => `${labelOf(graph, e.from)} -${e.relation}-> ${labelOf(graph, e.to)}`),
    coverage: allCoverage,
    coverageRate: allCoverage.filter((c) => c.pass).length / allCoverage.length,
    violations,
    extraCheck,
  };
}

function parseArgs(argv) {
  const out = { reps: 3, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reps') out.reps = Number(argv[++i]);
    else if (argv[i] === '--only') out.only = argv[++i].split(',');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const runs = [];
  for (const [id, spec] of Object.entries(CASES)) {
    if (args.only && !args.only.includes(id)) continue;
    const mod = await import(path.join(FIXTURES, `${id.toLowerCase()}.mjs`));
    const fixture = mod.default;
    const finals = fixture.events.filter((e) => e.event?.phase === 'final').map((e) => e.event);
    if (!finals.length) throw new Error(`${id} has no final events`);
    for (let rep = 1; rep <= args.reps; rep++) {
      const { ledger, store } = makeEnv();
      for (const ev of finals) {
        const ingested = ledger.ingest({ ...ev, kind: 'transcript', epoch: ledger.epoch });
        if (!ingested.ok) throw new Error(`${id} ingest failed: ${ingested.code} ${ingested.detail || ''}`);
      }
      const request = buildRequest(store, ledger, `${id.toLowerCase()}r${rep}`);
      const out = await understand({ request });
      let committed = null;
      if (out.response.status !== 'degraded') {
        const began = store.beginRequest(request);
        if (began.ok) committed = store.commit(out.response, request);
      }
      const graph = committed ? snapshotOf(store) : { nodes: [], edges: [], scenes: [], active: null, unresolved: [] };
      const score = scoreCase(spec, graph);
      runs.push({
        case: id,
        rep,
        request_id: request.request_id,
        status: out.response.status,
        reason: out.response.reason || null,
        model: out.meta.model,
        latency_ms: out.meta.latency_ms,
        usage: out.meta.usage,
        committed: committed ? { ok: committed.ok, code: committed.code || null } : null,
        ops: out.response.ops?.length || 0,
        scenes: graph.scenes.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        graph: {
          scenes: graph.scenes.map((s) => ({ id: s.id, title: s.title, family: s.family, status: s.status })),
          nodes: graph.nodes.map((n) => ({ label: n.label, claim_kind: n.claim_kind, state: n.state })),
          edges: graph.edges.map((e) => ({
            from: labelOf(graph, e.from),
            to: labelOf(graph, e.to),
            relation: e.relation,
            label: e.label,
            claim_kind: e.claim_kind,
            state: e.state,
          })),
          unresolved: graph.unresolved.map((u) => u.text),
        },
        score,
      });
      process.stderr.write(`${id} rep${rep}: ${out.response.status} ${out.meta.latency_ms}ms ops=${out.response.ops?.length || 0}\n`);
    }
  }
  const ok = runs.filter((r) => r.status === 'ok' && r.committed?.ok);
  const relationCases = runs.filter((r) => r.score.required > 0);
  const required = relationCases.reduce((n, r) => n + r.score.required, 0);
  const matched = relationCases.reduce((n, r) => n + r.score.matched, 0);
  const unclassifiedEdges = relationCases.flatMap((r) =>
    r.score.extraEdges.slice(r.score.allowed || 0).map((e) => `${r.case}: ${e}`),
  );
  const modelEdges = relationCases.reduce((n, r) => n + r.score.matched + Math.max(0, r.score.extraEdges.length - (r.score.allowed || 0)), 0);
  const coverageAll = runs.flatMap((r) => r.score.coverage);
  const violations = runs.flatMap((r) => r.score.violations);
  const latencies = runs.map((r) => r.latency_ms).sort((a, b) => a - b);
  const usage = runs.reduce(
    (acc, r) => {
      acc.prompt += r.usage?.prompt_tokens || 0;
      acc.completion += r.usage?.completion_tokens || 0;
      acc.cached += r.usage?.prompt_cache_hit_tokens || 0;
      return acc;
    },
    { prompt: 0, completion: 0, cached: 0 },
  );
  const summary = {
    at: new Date().toISOString(),
    reps: args.reps,
    duration_ms: Date.now() - started,
    model: runs[0]?.model,
    samples: runs.length,
    ok: ok.length,
    degraded: runs.filter((r) => r.status === 'degraded').length,
    relation_recall: required ? matched / required : null,
    relation_precision: modelEdges ? matched / modelEdges : null,
    unclassified_edges: unclassifiedEdges,
    required_relations: required,
    matched_relations: matched,
    core_coverage: coverageAll.length ? coverageAll.filter((c) => c.pass).length / coverageAll.length : null,
    severe_violations: violations.length,
    violations,
    latency_ms: {
      min: latencies[0] ?? null,
      p50: latencies[Math.floor((latencies.length - 1) * 0.5)] ?? null,
      p95: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? null,
      max: latencies.at(-1) ?? null,
    },
    usage,
    runs,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `eval-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  const brief = {
    file: path.relative(ROOT, file),
    samples: summary.samples,
    ok: summary.ok,
    degraded: summary.degraded,
    recall: summary.relation_recall,
    precision: summary.relation_precision,
    coverage: summary.core_coverage,
    violations: summary.severe_violations,
    latency_ms: summary.latency_ms,
    usage: summary.usage,
  };
  console.log(JSON.stringify(brief, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
