// C10：60 秒持续输入，每 500ms 一条；每个 1s 段含两次 partial、一次 final、一条迟到 partial。
const events = [];
for (let k = 0; k < 60; k++) {
  const base = k * 1000;
  const sid = `c10-${k + 1}`;
  const topic = `第${k + 1}个独立观点`;
  events.push({ at_ms: base, event: { kind: "transcript", segment_id: sid, order: k + 1, revision: 1, phase: "partial", text: topic } });
  events.push({ at_ms: base + 300, event: { kind: "transcript", segment_id: sid, order: k + 1, revision: 2, phase: "partial", text: `${topic}，补充一点` } });
  events.push({ at_ms: base + 600, event: { kind: "transcript", segment_id: sid, order: k + 1, revision: 3, phase: "final", text: `${topic}，补充一点，这句讲完了` } });
  events.push({ at_ms: base + 800, event: { kind: "transcript", segment_id: sid, order: k + 1, revision: 2, phase: "partial", text: `${topic}，补充一点` } });
}
export default {
  id: "C10",
  title: "60 秒持续输入，partial 合并与 final 不丢",
  duration_ms: 60000,
  events,
  checkpoints: [{ at_ms: 60000, expect: { segment_count: 60, pending_count: 60, rejected_codes: ["late_revision"] } }],
};
