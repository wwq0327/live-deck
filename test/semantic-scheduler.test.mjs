import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticScheduler, waitFor } from '../public/semantic/scheduler.js';
import { makeEnv } from './helpers/semantic.mjs';
import { makeId } from '../public/semantic/protocol.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function event(ledger, segment_id, revision, phase, text, order) {
  return {
    kind: 'transcript',
    epoch: ledger.epoch,
    segment_id,
    revision,
    phase,
    text,
    order: order ?? ledger.nextOrder(),
  };
}

function reply(request, { status = 'ok', reason, ops = [], considered, unresolved = [] } = {}) {
  return {
    schema_version: 1,
    request_id: request.request_id,
    epoch: request.epoch,
    base_graph_version: request.base_graph_version,
    input_version: request.input_version,
    status,
    reason,
    considered: considered ?? request.sources.map((s) => ({ segment_id: s.segment_id, revision: s.revision })),
    ops,
    unresolved,
  };
}

function makeNet() {
  const pending = [];
  const impl = (url, opts) =>
    new Promise((resolve, reject) => {
      pending.push({ url, opts, body: JSON.parse(opts.body), resolve, reject });
    });
  return {
    impl,
    pending,
    take() {
      return pending.shift();
    },
  };
}

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function makeScheduler(net, env, config = {}) {
  return new SemanticScheduler({
    store: env.store,
    ledger: env.ledger,
    fetchImpl: net.impl,
    config: { debounceMs: 10, maxWaitMs: 40, clientTimeoutMs: 500, retryDelayMs: 10, ...config },
  });
}

async function waitForRequest(net, count = 1) {
  const ok = await waitFor(() => net.pending.length >= count, { timeoutMs: 2000 });
  assert.equal(ok, true, `expected ${count} pending request(s), saw ${net.pending.length}`);
}

test('快速连续输入合并成一次请求，只带最新 revision', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env);
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'partial', '资料放在微信', 1));
  env.ledger.ingest(event(env.ledger, 'seg1', 2, 'partial', '资料放在微信、文档和表格里', 1));
  env.ledger.ingest(event(env.ledger, 'seg1', 3, 'final', '资料放在微信、文档和表格里，所以找东西时我得来回切换', 1));
  await waitForRequest(net);
  assert.equal(net.pending.length, 1);
  const req = net.pending[0];
  assert.equal(req.body.sources.length, 1);
  assert.equal(req.body.sources[0].revision, 3);
  assert.match(req.body.sources[0].text, /来回切换/);
  assert.equal(req.body.base_graph_version, 0);

  req.resolve(json(reply(req.body)));
  await waitFor(() => env.ledger.unconsumedFinals().length === 0, { timeoutMs: 1000 });
  assert.equal(s.diagnostics.counters.committed, 1);
  assert.equal(s.diagnostics.state, 'idle');
  s.stop();
});

test('在途请求期间新输入排队，返回后立即发起下一次且不丢 final', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '第一段', 1));
  await waitForRequest(net);
  const first = net.take();

  env.ledger.ingest(event(env.ledger, 'seg2', 1, 'final', '第二段', 2));
  env.ledger.ingest(event(env.ledger, 'seg3', 1, 'final', '第三段', 3));
  await sleep(60);
  assert.equal(net.pending.length, 0, 'must not start a second request while one is in flight');
  assert.equal(s.diagnostics.in_flight, true);

  first.resolve(json(reply(first.body)));
  await waitForRequest(net);
  const second = net.take();
  const ids = second.body.sources.map((x) => x.segment_id).sort();
  assert.deepEqual(ids, ['seg1', 'seg2', 'seg3']);
  second.resolve(json(reply(second.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(s.diagnostics.counters.requests, 2);
  s.stop();
});

test('持续输入也会在 maxWait 内触发，不等静音或句号', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 1000, maxWaitMs: 30 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'partial', '第一版', 1));
  const startedAt = Date.now();
  for (let i = 2; i <= 8; i++) {
    await sleep(8);
    env.ledger.ingest(event(env.ledger, 'seg1', i, 'partial', `第一版第${i}次补充`, 1));
  }
  await waitForRequest(net);
  assert.ok(Date.now() - startedAt < 400, 'request must fire before the stream ends');
  const streamed = net.take().body.sources[0];
  assert.ok(streamed.revision >= 2 && streamed.revision < 8, 'request carries the latest draft seen so far');
  s.stop();
});

test('重复 partial 不触发新请求', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  s.start();
  const ev = event(env.ledger, 'seg1', 1, 'partial', '同一句话', 1);
  env.ledger.ingest(ev);
  env.ledger.ingest(ev);
  env.ledger.ingest(ev);
  await waitForRequest(net);
  await sleep(60);
  assert.equal(net.pending.length, 1);
  assert.equal(s.diagnostics.counters.requests, 1);
  s.stop();
});

test('超过 sources 上限时不静默丢弃 final：先发有界批，再排空积压', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  for (let i = 1; i <= 30; i++) {
    env.ledger.ingest(event(env.ledger, `seg${i}`, 1, 'final', `第${i}条独立观点，需要进入账本`, i));
  }
  s.start();
  await waitForRequest(net);
  const first = net.take();
  assert.equal(first.body.sources.length, 24);
  assert.equal(s.diagnostics.backlog.dropped >= 6, true);
  first.resolve(json(reply(first.body)));
  await waitForRequest(net);
  const second = net.take();
  assert.ok(second.body.sources.some((x) => Number(x.segment_id.slice(3)) > 24));
  second.resolve(json(reply(second.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(env.ledger.unconsumedFinals().length, 0);
  assert.equal(s.diagnostics.counters.requests, 2);
  s.stop();
});

test('版本冲突整批拒绝并用最新状态重算', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5, retryDelayMs: 5 });
  s.start();

  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '资料分散', 1));
  await waitForRequest(net);
  const r1 = net.take();
  const sid = makeId('scene', r1.body.request_id, 1);
  const nid = makeId('node', r1.body.request_id, 1);
  r1.resolve(
    json(
      reply(r1.body, {
        ops: [
          { op: 'create_scene', scene: { id: sid, title: '资料分散', family: 'cause' } },
          {
            op: 'upsert_node',
            node: {
              id: nid,
              scene_id: sid,
              label: '资料分散在多个工具',
              role: 'cause',
              claim_kind: 'assertion',
              speaker_id: 'unknown',
              state: 'supported',
              evidence: [{ segment_id: 'seg1', revision: 1, quote: '资料分散' }],
            },
          },
        ],
      })
    )
  );
  await waitFor(() => env.store.graphVersion === 1, { timeoutMs: 1000 });

  env.ledger.ingest(event(env.ledger, 'seg2', 1, 'final', '找东西要来回切换', 2));
  await waitForRequest(net);
  const r2 = net.take();
  const manual = env.store.applyManual([{ op: 'upsert_node', node: { id: nid, label: '人工改写过的标签' } }]);
  assert.equal(manual.ok, true);
  assert.equal(env.store.graphVersion, 2);

  r2.resolve(
    json(
      reply(r2.body, {
        ops: [
          { op: 'upsert_node', node: { id: makeId('node', r2.body.request_id, 1), scene_id: sid, label: '来回切换', role: 'effect', claim_kind: 'assertion', speaker_id: 'unknown', evidence: [{ segment_id: 'seg2', revision: 1, quote: '来回切换' }] } },
        ],
      })
    )
  );
  await waitForRequest(net);
  const r3 = net.take();
  assert.equal(r3.body.base_graph_version, 2);
  assert.equal(s.diagnostics.counters.rejected, 1);
  r3.resolve(json(reply(r3.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(env.ledger.unconsumedFinals().length, 0);
  assert.equal(env.store.graphVersion, 2, 'empty ok batch must not bump version');
  s.stop();
});

test('请求发出后同一段被纠正：旧响应不消费，按新 revision 重算', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5, retryDelayMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '这个办法能减少切换', 1));
  await waitForRequest(net);
  const first = net.take();
  env.ledger.ingest(event(env.ledger, 'seg1', 2, 'final', '这个办法不能减少切换', 1));
  first.resolve(json(reply(first.body)));
  await waitForRequest(net);
  const second = net.take();
  assert.equal(second.body.sources[0].revision, 2);
  assert.equal(Object.keys(env.ledger.receipts()).length, 0, 'old revision must not be confirmed consumed');
  second.resolve(json(reply(second.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  const cur = env.ledger.current('seg1');
  assert.equal(cur.revision, 2);
  assert.equal(env.ledger.receipts().seg1, 2);
  s.stop();
});

test('暂态错误只重试一次，成功后续跑', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5, retryDelayMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '还会再试一次', 1));
  await waitForRequest(net);
  const first = net.take();
  first.resolve(json(reply(first.body, { status: 'degraded', reason: 'timeout' })));
  await waitForRequest(net);
  assert.equal(s.diagnostics.counters.retries, 1);
  const second = net.take();
  second.resolve(json(reply(second.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(s.diagnostics.counters.committed, 1);
  assert.equal(s.diagnostics.halted, null);
  s.stop();
});

test('持续失败不无限重试：最多一次重试后停住并保留未消费输入', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5, retryDelayMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '一直失败', 1));
  await waitForRequest(net);
  const first = net.take();
  first.resolve(json(reply(first.body, { status: 'degraded', reason: 'timeout' })));
  await waitForRequest(net);
  const second = net.take();
  second.resolve(json(reply(second.body, { status: 'degraded', reason: 'timeout' })));
  await waitFor(() => s.diagnostics.halted === 'degraded:timeout', { timeoutMs: 1000 });
  await sleep(80);
  assert.equal(s.diagnostics.counters.requests, 2);
  assert.equal(env.ledger.pendingCount(), 1);
  assert.equal(Object.keys(env.ledger.receipts()).length, 0);
  s.stop();
});

test('无 Key 时不重试、不消费、保留最后有效图', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '没有密钥时的输入', 1));
  await waitForRequest(net);
  const req = net.take();
  req.resolve(json(reply(req.body, { status: 'degraded', reason: 'no_key' })));
  await waitFor(() => s.diagnostics.halted === 'no_key', { timeoutMs: 1000 });
  await sleep(80);
  assert.equal(s.diagnostics.counters.requests, 1);
  assert.equal(env.ledger.pendingCount(), 1);
  assert.equal(env.store.graphVersion, 0);
  assert.equal(Object.keys(env.ledger.receipts()).length, 0);
  s.stop();
});

test('reset 后旧 epoch 响应不污染，新 epoch 可继续提交', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '旧会话内容', 1));
  await waitForRequest(net);
  const old = net.take();
  env.ledger.reset({ epoch: 2 });
  env.store.reset({ epoch: 2 });
  old.resolve(json(reply(old.body)));
  await sleep(40);
  assert.equal(env.store.graphVersion, 0);
  assert.equal(s.diagnostics.counters.committed, 0);

  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '新会话内容', 1));
  await waitForRequest(net);
  const fresh = net.take();
  assert.equal(fresh.body.epoch, 2);
  fresh.resolve(json(reply(fresh.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(s.diagnostics.counters.committed, 1);
  s.stop();
});

test('hold 消费输入但只更新未决点；markVisible 记录上屏延迟', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'final', '还没说完，先等等', 1));
  await waitForRequest(net);
  const req = net.take();
  req.resolve(
    json(
      reply(req.body, {
        status: 'hold',
        unresolved: [{ text: '等讲话者补充因果', evidence: [{ segment_id: 'seg1', revision: 1, quote: '还没说完' }] }],
      })
    )
  );
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1000 });
  assert.equal(env.store.graphVersion, 0);
  assert.equal(env.store.state.unresolved.length, 1);
  const ms = s.markVisible(req.body.request_id);
  assert.equal(typeof ms, 'number');
  assert.ok(ms >= 0);
  assert.equal(s.diagnostics.counters.visible, 1);
  s.stop();
});

test('连续讲话（压缩到 1.5 秒）：最多一个在途，final 全部消费，请求数有限', async () => {
  const env = makeEnv();
  let concurrent = 0;
  let maxConcurrent = 0;
  const requests = [];
  const impl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(6);
    concurrent -= 1;
    return json(reply(body));
  };
  const s = new SemanticScheduler({
    store: env.store,
    ledger: env.ledger,
    fetchImpl: impl,
    config: { debounceMs: 12, maxWaitMs: 30, clientTimeoutMs: 500 },
  });
  s.start();
  for (let i = 1; i <= 30; i++) {
    env.ledger.ingest(event(env.ledger, `seg${i}`, 1, 'partial', `第${i}段草稿`, i));
    env.ledger.ingest(event(env.ledger, `seg${i}`, 2, 'final', `第${i}段最终内容`, i));
    await sleep(3);
  }
  const drained = await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 4000 });
  assert.equal(drained, true, `pending left: ${env.ledger.pendingCount()}, state ${s.diagnostics.state}`);
  assert.equal(maxConcurrent, 1);
  assert.equal(env.ledger.unconsumedFinals().length, 0);
  assert.ok(requests.length >= 2 && requests.length <= 30, `requests=${requests.length}`);
  for (const req of requests) {
    const keys = req.sources.map((src) => `${src.segment_id}@${src.revision}`);
    assert.equal(new Set(keys).size, keys.length, 'one revision per segment per request');
  }
  assert.equal(s.diagnostics.counters.requests, requests.length);
  s.stop();
});

test('连续 partial 让多批响应过期时不永久停摆，最终按最新 revision 提交', async () => {
  const env = makeEnv();
  const net = makeNet();
  const s = makeScheduler(net, env, { debounceMs: 5, retryDelayMs: 5, maxRecompute: 1, recomputeBackoffMs: 5 });
  s.start();
  env.ledger.ingest(event(env.ledger, 'seg1', 1, 'partial', '资料放在微信', 1));
  await waitForRequest(net);
  const first = net.take();
  env.ledger.ingest(event(env.ledger, 'seg1', 2, 'partial', '资料放在微信和文档', 1));
  first.resolve(json(reply(first.body)));
  await waitForRequest(net);
  const second = net.take();
  env.ledger.ingest(event(env.ledger, 'seg1', 3, 'partial', '资料放在微信、文档和表格', 1));
  second.resolve(json(reply(second.body)));
  await waitForRequest(net);
  const third = net.take();
  assert.equal(third.body.sources[0].revision, 3);
  assert.equal(s.diagnostics.halted, null, 'must not halt while the speaker keeps revising');
  third.resolve(json(reply(third.body)));
  await waitFor(() => env.ledger.pendingCount() === 0, { timeoutMs: 1500 });
  assert.equal(s.diagnostics.halted, null);
  assert.equal(s.diagnostics.counters.rejected, 2);
  assert.equal(env.ledger.receipts().seg1, 3);
  s.stop();
});
