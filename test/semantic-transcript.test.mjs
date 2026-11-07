import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptLedger } from '../public/semantic/transcript.js';

let clock = 0;
const now = () => clock;
function fresh() {
  clock = 1000;
  return new TranscriptLedger({ epoch: 1, now });
}

function ev(over = {}) {
  return {
    kind: 'transcript',
    epoch: 1,
    segment_id: 'seg1',
    order: 1,
    revision: 1,
    phase: 'partial',
    text: '资料放在微信',
    ...over,
  };
}

test('多次 partial 加 final 只形成一份内容，final 封口', () => {
  const l = fresh();
  assert.equal(l.ingest(ev()).applied, true);
  let r = l.ingest(ev({ revision: 2, text: '资料放在微信、文档和表格里' }));
  assert.equal(r.applied, true);
  assert.equal(r.invalidations.length, 1);
  assert.equal(r.invalidations[0].revision, 1);
  r = l.ingest(ev({ revision: 3, phase: 'final', text: '资料放在微信、文档和表格里，所以找东西时我得来回切换' }));
  assert.equal(r.entry.phase, 'final');
  assert.equal(l.segments().length, 1);
  assert.equal(l.segments()[0].text, '资料放在微信、文档和表格里，所以找东西时我得来回切换');
  assert.equal(l.current('seg1').sealed, true);
  assert.equal(l.input_version, 3);
  // 历史 revision 可查，但当前视图不用旧草稿
  assert.equal(l.getRevision('seg1', 1).text, '资料放在微信');
  assert.equal(l.getRevision('seg1', 1).superseded, true);
  assert.equal(l.segments()[0].text.includes('资料放在微信资料'), false);
});

test('迟到 partial 不覆盖 final；同 revision 异文是冲突', () => {
  const l = fresh();
  l.ingest(ev({ revision: 1, phase: 'final', text: '这个办法不能减少切换' }));
  const late = l.ingest(ev({ revision: 2, phase: 'partial', text: '这个办法能减少切换' }));
  assert.equal(late.ok, false);
  assert.equal(late.code, 'sealed');
  const same = l.ingest(ev({ revision: 1, phase: 'final', text: '这个办法能减少切换' }));
  assert.equal(same.ok, false);
  assert.equal(same.code, 'revision_conflict');
  assert.equal(l.current('seg1').text, '这个办法不能减少切换');
});

test('更高 revision 的 final 纠正，触发旧 revision 失效事件', () => {
  const l = fresh();
  l.ingest(ev({ revision: 1, phase: 'final', text: '价格是主要原因' }));
  const r = l.ingest(ev({ revision: 2, phase: 'final', text: '入口不好找才是主要原因' }));
  assert.equal(r.applied, true);
  assert.equal(r.invalidations[0].revision, 1);
  assert.equal(l.current('seg1').revision, 2);
  assert.equal(l.getRevision('seg1', 1).text, '价格是主要原因');
  assert.equal(l.isCurrent('seg1', 1), false);
});

test('同一事件重放幂等，不增加 input_version', () => {
  const l = fresh();
  l.ingest(ev());
  const version = l.input_version;
  const dup = l.ingest(ev());
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(l.input_version, version);
});

test('乱序 final 按采集顺序排列；B 先到不改变讲话顺序', () => {
  const l = fresh();
  l.ingest(ev({ segment_id: 'segB', order: 2, revision: 1, phase: 'final', text: 'B 句' }));
  l.ingest(ev({ segment_id: 'segA', order: 1, revision: 1, phase: 'final', text: 'A 句' }));
  assert.deepEqual(l.segments().map((s) => s.text), ['A 句', 'B 句']);
  assert.deepEqual(l.unconsumedFinals().map((s) => s.segment_id), ['segA', 'segB']);
});

test('order 在采集时绑定：同一 segment 换 order 被拒绝', () => {
  const l = fresh();
  l.ingest(ev({ order: 5 }));
  const r = l.ingest(ev({ order: 6, revision: 2, text: '别的' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'order_conflict');
});

test('after final 的同 revision partial 被拒；不同 revision partial 也不行', () => {
  const l = fresh();
  l.ingest(ev({ revision: 4, phase: 'final', text: '最终文本' }));
  assert.equal(l.ingest(ev({ revision: 4, phase: 'partial', text: '最终文本' })).code, 'sealed');
  assert.equal(l.ingest(ev({ revision: 5, phase: 'partial', text: '又改' })).code, 'sealed');
});

test('receipts 只确认当前 revision；被纠正文案重新计为未消费', () => {
  const l = fresh();
  l.ingest(ev({ revision: 1, phase: 'final', text: '价格是主因' }));
  l.markConsumed([{ segment_id: 'seg1', revision: 1 }]);
  assert.equal(l.hasPendingInput(), false);
  l.ingest(ev({ revision: 2, phase: 'final', text: '入口是主因' }));
  assert.equal(l.hasPendingInput(), true);
  assert.equal(l.unconsumedFinals().length, 1);
  assert.equal(l.pendingCount(), 1);
});

test('buildSources：未消费 final 全保留，最新 partial 在内，旧已消费只按窗口补', () => {
  const l = fresh();
  for (let i = 1; i <= 6; i++) {
    clock += 1000;
    l.ingest(ev({ segment_id: `s${i}`, order: i, revision: 1, phase: 'final', text: `第${i}句：这是一些资料` }));
  }
  for (let i = 1; i <= 4; i++) l.markConsumed([{ segment_id: `s${i}`, revision: 1 }]);
  clock += 1000;
  l.ingest(
    ev({ segment_id: 'live', order: 7, revision: 1, phase: 'partial', text: '现在还说一半' })
  );
  const out = l.buildSources({ nowMs: clock, maxSources: 5, maxChars: 3000 });
  const ids = out.sources.map((s) => s.segment_id);
  assert.ok(ids.includes('s5') && ids.includes('s6'), '未消费 final 不能被裁掉');
  assert.ok(ids.includes('live'));
  assert.equal(out.sources.find((s) => s.segment_id === 'live').phase, 'partial');
  assert.deepEqual(out.sources.map((s) => s.order), [...out.sources.map((s) => s.order)].sort((a, b) => a - b));

  const tight = l.buildSources({ nowMs: clock, maxSources: 2, maxChars: 3000 });
  assert.equal(tight.sources.length, 2);
  assert.equal(tight.backlog.finals, 2);
  assert.equal(tight.backlog.dropped, 1);
});

test('reset 后旧 epoch 事件全部失效', () => {
  const l = fresh();
  l.ingest(ev());
  l.reset({ epoch: 2 });
  assert.equal(l.ingest(ev()).code, 'stale_epoch');
  assert.equal(l.ingest(ev({ epoch: 2 })).ok, true);
  assert.equal(l.input_version, 1);
});

test('空文本不产生消费项；speaker 冲突被拒绝', () => {
  const l = fresh();
  assert.equal(l.ingest(ev({ text: '   ' })).applied, false);
  l.ingest(ev({ speaker_id: 'alice', phase: 'final', text: '甲说的' }));
  assert.equal(l.ingest(ev({ speaker_id: 'bob', revision: 2, phase: 'final', text: '乙说的' })).code, 'speaker_conflict');
});
