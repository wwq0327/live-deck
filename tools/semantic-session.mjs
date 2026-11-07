#!/usr/bin/env node
// 从浏览器 __semanticDebug.diagnostics.events 的导出计算时延分位数。
//   node tools/semantic-session.mjs session.json
import fs from 'node:fs';

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]);
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/semantic-session.mjs <session.json>');
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = input.events || input.diagnostics?.events || input;
const inputs = events.filter((e) => e.kind === 'input');
const starts = events.filter((e) => e.kind === 'request_started');
const commits = events.filter((e) => e.kind === 'commit');
const degraded = events.filter((e) => e.kind === 'degraded');
const halted = events.filter((e) => e.kind === 'halt');
const sample = [];
for (const commit of commits) {
  const start = [...starts].reverse().find((s) => s.request_id === commit.request_id);
  if (!start) continue;
  const before = inputs.filter((i) => i.at <= start.at);
  const lastInput = before.at(-1);
  const sched = lastInput ? start.at - lastInput.at : null;
  sample.push({
    request_id: commit.request_id,
    input_to_request_ms: sched,
    request_to_commit_ms: commit.latency_ms,
    commit_to_visible_ms: commit.visible_ms ?? null,
    input_to_visible_ms: sched != null ? sched + (commit.latency_ms || 0) + (commit.visible_ms || 0) : null,
    ops: commit.ops,
    applied: commit.applied,
  });
}
const pick = (key) => sample.map((s) => s[key]).filter((v) => Number.isFinite(v));
const summary = {
  inputs: inputs.length,
  requests: starts.length,
  commits: commits.length,
  degraded: degraded.length,
  halted: halted.length,
  scheduling_ms: { p50: pct(pick('input_to_request_ms'), 50), p95: pct(pick('input_to_request_ms'), 95) },
  model_ms: { p50: pct(pick('request_to_commit_ms'), 50), p95: pct(pick('request_to_commit_ms'), 95) },
  visible_ms: { p50: pct(pick('commit_to_visible_ms'), 50), p95: pct(pick('commit_to_visible_ms'), 95) },
  semantic_on_screen_ms: { p50: pct(pick('input_to_visible_ms'), 50), p95: pct(pick('input_to_visible_ms'), 95) },
  samples: sample,
};
console.log(JSON.stringify(summary, null, 2));
