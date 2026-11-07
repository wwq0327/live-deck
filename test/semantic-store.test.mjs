import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest,
  edge,
  evidence,
  makeEnv,
  node,
  respond,
  scene,
  seedSegments,
} from './helpers/semantic.mjs';
import { SCHEMA_VERSION, makeId } from '../public/semantic/protocol.js';

test('新增因果链：scene + nodes + edges 一次原子提交，版本加一', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['资料放在微信、文档和表格里，所以找东西时我得来回切换']);
  const request = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const storage = makeId('node', 'r1', 2);
  const search = makeId('node', 'r1', 3);
  const cost = makeId('node', 'r1', 4);
  const ev = [evidence(s1, '找东西时我得来回切换')];
  const out = respond(store, ledger, request, [
    scene('r1', 1, '分散存储导致来回切换'),
    node('r1', 2, sceneId, '资料分散在三处', ev),
    node('r1', 3, sceneId, '找东西来回切换', ev),
    node('r1', 4, sceneId, '切换更花时间', ev),
    edge('r1', 5, sceneId, storage, search, 'causes', ev),
    edge('r1', 6, sceneId, search, cost, 'causes', ev),
  ]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.committed, true);
  assert.equal(store.graphVersion, 1);
  const graph = store.sceneGraph(sceneId);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(store.activeScene().title, '分散存储导致来回切换');
  assert.deepEqual(store.snapshot().receipts, { [s1]: 1 });
  assert.equal(store.snapshot().history.at(-1).op_count, 6);
});

test('同 ID 修正标签：保留对象身份，不新增节点，版本递增', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['用户流失是因为操作太复杂。']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const cause = makeId('node', 'r1', 2);
  const ev = [evidence(s1, '操作太复杂')];
  respond(store, ledger, r1, [
    scene('r1', 1, '用户流失的原因'),
    node('r1', 2, sceneId, '操作太复杂', ev),
    node('r1', 3, sceneId, '用户流失', ev),
    edge('r1', 4, sceneId, cause, makeId('node', 'r1', 3), 'causes', ev),
  ]);
  const before = store.sceneGraph(sceneId).nodes.find((n) => n.id === cause);
  const r2 = buildRequest(store, ledger, 'r2');
  const out = respond(store, ledger, r2, [
    {
      op: 'upsert_node',
      node: {
        id: cause,
        scene_id: sceneId,
        label: '新用户找不到入口',
        role: 'cause',
        claim_kind: 'assertion',
        evidence: ev,
      },
    },
  ]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  const after = store.sceneGraph(sceneId).nodes.find((n) => n.id === cause);
  assert.equal(after.label, '新用户找不到入口');
  assert.equal(after.created_at, before.created_at);
  assert.equal(store.sceneGraph(sceneId).nodes.length, 2);
  assert.equal(store.graphVersion, 2);
});

test('撤回节点连带撤回关联边；关系撤回保留历史', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['不是低价带来增长，是新入口带来了更多访问。']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const price = makeId('node', 'r1', 2);
  const entry = makeId('node', 'r1', 3);
  const growth = makeId('node', 'r1', 4);
  const ev = [evidence(s1, '新入口带来了更多访问')];
  respond(store, ledger, r1, [
    scene('r1', 1, '增长的原因', 'convergence'),
    node('r1', 2, sceneId, '低价', ev),
    node('r1', 3, sceneId, '新入口', ev),
    node('r1', 4, sceneId, '更多访问', ev),
    edge('r1', 5, sceneId, price, growth, 'causes', ev),
    edge('r1', 6, sceneId, entry, growth, 'causes', ev),
  ]);
  const r2 = buildRequest(store, ledger, 'r2');
  const out = respond(store, ledger, r2, [
    { op: 'retract', id: price, reason: '讲者否定' },
  ]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  const graph = store.sceneGraph(sceneId);
  assert.equal(graph.nodes.find((n) => n.id === price).state, 'retracted');
  assert.equal(graph.edges.find((e) => e.id === makeId('edge', 'r1', 5)).state, 'retracted');
  assert.equal(graph.edges.find((e) => e.id === makeId('edge', 'r1', 6)).state, 'supported');
});

test('来源 revision 被改写：依赖对象标 stale，版本递增，可重算', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['这个办法能减少切换']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const a = makeId('node', 'r1', 2);
  respond(store, ledger, r1, [
    scene('r1', 1, '办法有效'),
    node('r1', 2, sceneId, '能减少切换', [evidence(s1, '能减少切换')]),
  ]);
  const v1 = store.graphVersion;
  const inv = store.invalidateSource(s1, 1, { reason: 'ASR 修正为否定' });
  assert.equal(inv.changed, true);
  assert.deepEqual(inv.affected, [a]);
  assert.equal(store.snapshot().nodes[a].state, 'stale');
  assert.equal(store.graphVersion, v1 + 1);
});

test('问题/设想保留 claim_kind；不得在 upsert 时伪装成 retracted', () => {
  const { ledger, store } = makeEnv();
  const [s1, s2] = seedSegments(ledger, ['会不会是价格太高，才导致用户流失？', '我想做一个统一入口，效果还需要试。']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const out = respond(store, ledger, r1, [
    scene('r1', 1, '一个待验证的猜测'),
    node('r1', 2, sceneId, '价格太高？', [evidence(s1, '价格太高')], { claim_kind: 'question' }),
    node('r1', 3, sceneId, '统一入口', [evidence(s2, '做一个统一入口')], { claim_kind: 'proposal' }),
  ]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(store.snapshot().nodes[makeId('node', 'r1', 2)].claim_kind, 'question');
  assert.equal(store.snapshot().nodes[makeId('node', 'r1', 3)].claim_kind, 'proposal');

  const r2 = buildRequest(store, ledger, 'r2');
  const bad = respond(store, ledger, r2, [
    {
      op: 'upsert_node',
      node: {
        id: makeId('node', 'r1', 2),
        scene_id: sceneId,
        label: '价格太高',
        claim_kind: 'assertion',
        state: 'retracted',
        evidence: [evidence(s1, '价格太高')],
      },
    },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid_ops');
});

const INVALID_CASES = [
  {
    name: '自环',
    ops: ({ sceneId, ev }) => [
      scene('r1', 1, '自环'),
      node('r1', 2, sceneId, 'A', ev),
      edge('r1', 3, sceneId, makeId('node', 'r1', 2), makeId('node', 'r1', 2), 'causes', ev),
    ],
  },
  {
    name: '跨 scene 端点',
    ops: ({ sceneId, ev }) => [
      scene('r1', 1, '场景一'),
      scene('r1', 2, '场景二'),
      node('r1', 3, sceneId, 'A', ev),
      node('r1', 4, makeId('scene', 'r1', 2), 'B', ev),
      edge('r1', 5, sceneId, makeId('node', 'r1', 3), makeId('node', 'r1', 4), 'causes', ev),
    ],
  },
  {
    name: '缺失端点',
    ops: ({ sceneId, ev }) => [
      scene('r1', 1, '缺端点'),
      node('r1', 2, sceneId, 'A', ev),
      edge('r1', 3, sceneId, makeId('node', 'r1', 2), makeId('node', 'r1', 99), 'causes', ev),
    ],
  },
  {
    name: '因果环',
    ops: ({ sceneId, ev }) => [
      scene('r1', 1, '环'),
      node('r1', 2, sceneId, 'A', ev),
      node('r1', 3, sceneId, 'B', ev),
      edge('r1', 4, sceneId, makeId('node', 'r1', 2), makeId('node', 'r1', 3), 'causes', ev),
      edge('r1', 5, sceneId, makeId('node', 'r1', 3), makeId('node', 'r1', 2), 'causes', ev),
    ],
  },
  {
    name: '未知 op',
    ops: () => [{ op: 'explode_everything', id: 'x' }],
  },
  {
    name: '别人的命名空间',
    ops: ({ sceneId, ev }) => [
      { op: 'create_scene', scene: { id: 's_other_1', title: '偷来的', family: 'cause' } },
      node('r1', 2, sceneId, 'A', ev),
    ],
  },
  {
    name: '重复新 ID',
    ops: ({ sceneId, ev }) => [scene('r1', 1, '重名'), scene('r1', 1, '重名')],
  },
  {
    name: '无效关系',
    ops: ({ sceneId, ev }) => [
      scene('r1', 1, '坏关系'),
      node('r1', 2, sceneId, 'A', ev),
      node('r1', 3, sceneId, 'B', ev),
      edge('r1', 4, sceneId, makeId('node', 'r1', 2), makeId('node', 'r1', 3), 'implies_magic', ev),
    ],
  },
];

for (const item of INVALID_CASES) {
  test(`非法操作整批拒绝且无部分修改：${item.name}`, () => {
    const { ledger, store } = makeEnv();
    const [s1] = seedSegments(ledger, ['资料放在微信里，所以找东西要来回切换']);
    const request = buildRequest(store, ledger, 'r1');
    const sceneId = makeId('scene', 'r1', 1);
    const ev = [evidence(s1, '找东西要来回切换')];
    const before = store.snapshot();
    const out = respond(store, ledger, request, item.ops({ sceneId, ev }));
    assert.equal(out.ok, false, `expected failure for ${item.name}`);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(store.snapshot().receipts, {});
  });
}

test('证据必须逐字存在且来自请求来源', () => {
  const { ledger, store } = makeEnv();
  const [s1, s2] = seedSegments(ledger, ['资料放在微信里', '所以找东西要来回切换']);
  const request = buildRequest(store, ledger, 'r1', {
    sources: [
      { segment_id: s1, revision: 1, order: 1, phase: 'final', text: '资料放在微信里', speaker_id: 'unknown' },
    ],
  });
  const sceneId = makeId('scene', 'r1', 1);
  const fake = respond(store, ledger, request, [
    scene('r1', 1, '证据'),
    node('r1', 2, sceneId, '切换', [evidence(s2, '来回切换')]),
  ]);
  assert.equal(fake.ok, false);
  assert.equal(fake.code, 'invalid_ops');
  assert.match(fake.errors.join(' '), /not provided in request sources/);

  const r2 = buildRequest(store, ledger, 'r2');
  const misquote = respond(store, ledger, r2, [
    scene('r2', 1, '证据'),
    node('r2', 2, makeId('scene', 'r2', 1), '切换', [evidence(s1, '资料放在微信里', 1)]),
    {
      op: 'upsert_node',
      node: {
        id: makeId('node', 'r2', 3),
        scene_id: makeId('scene', 'r2', 1),
        label: '切换',
        claim_kind: 'assertion',
        evidence: [evidence(s1, '原文没有这句')],
      },
    },
  ]);
  assert.equal(misquote.ok, false);
  assert.match(misquote.errors.join(' '), /not found verbatim/);
});

test('base_graph_version 冲突整批拒绝；单纯新增输入不拒绝', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['先换界面，后来用户增长了']);
  const request = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const ev = [evidence(s1, '用户增长了')];
  respond(store, ledger, request, [scene('r1', 1, '增长'), node('r1', 2, sceneId, '用户增长', ev)]);

  const stale = buildRequest(store, ledger, 'r2');
  stale.base_graph_version = 0;
  const rejected = respond(store, ledger, stale, [
    { op: 'update_scene', scene: { id: sceneId, title: '改名' } },
  ]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'version_conflict');

  // 新输入到达，但请求的 sources 未变：旧 base 仍可提交。
  const live = buildRequest(store, ledger, 'r3');
  ledger.ingest({
    kind: 'transcript',
    epoch: ledger.epoch,
    segment_id: 'seg-new',
    order: 99,
    revision: 1,
    phase: 'partial',
    text: '不过我还不能确定两者有没有关系',
  });
  const ok = respond(store, ledger, live, [node('r3', 1, sceneId, '还不能确定', ev)]);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('依赖来源被改写：整批拒绝，不确认消费', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['这个办法能减少切换']);
  const request = buildRequest(store, ledger, 'r1');
  const requestSources = request.sources.map((s) => ({ ...s }));
  const sceneId = makeId('scene', 'r1', 1);
  ledger.ingest({
    kind: 'transcript',
    epoch: ledger.epoch,
    segment_id: s1,
    order: 1,
    revision: 2,
    phase: 'final',
    text: '这个办法不能减少切换',
  });
  const out = respond(store, ledger, request, [
    scene('r1', 1, '办法有效'),
    node('r1', 2, sceneId, '减少切换', [evidence(s1, '能减少切换', 1)]),
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'source_changed');
  assert.deepEqual(store.snapshot().receipts, {});
  assert.equal(store.graphVersion, 0);
  assert.equal(requestSources[0].revision, 1);
});

test('同响应重放幂等；未在途的请求不能提交', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['资料放在微信里']);
  const request = buildRequest(store, ledger, 'r1');
  const response = {
    schema_version: SCHEMA_VERSION,
    request_id: 'r1',
    epoch: 1,
    base_graph_version: 0,
    input_version: ledger.input_version,
    status: 'ok',
    considered: [{ segment_id: s1, revision: 1 }],
    ops: [scene('r1', 1, '素材分散')],
    unresolved: [],
  };
  assert.equal(store.beginRequest(request).ok, true);
  const first = store.commit(response, request);
  assert.equal(first.committed, true);
  const replay = store.commit(response, request);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(store.graphVersion, 1);

  const unknown = store.commit({ ...response, request_id: 'nope' }, { ...request, request_id: 'nope' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_request');
});

test('hold 只更新 receipts 与未决，不改图；degraded 不消费', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['我们还没讲完，这里是半句']);
  const request = buildRequest(store, ledger, 'r1');
  const hold = respond(store, ledger, request, [], { status: 'hold', unresolved: [{ text: '等他讲完因果', evidence: [evidence(s1, '半句')] }] });
  assert.equal(hold.ok, true);
  assert.equal(hold.committed, true);
  assert.equal(hold.applied, false);
  assert.equal(store.graphVersion, 0);
  assert.deepEqual(store.snapshot().receipts, { [s1]: 1 });
  assert.equal(store.snapshot().unresolved.length, 1);

  const [s2] = seedSegments(ledger, ['第二句'], { order: 1, orderBase: 2 });
  const r2 = buildRequest(store, ledger, 'r2');
  const begin = store.beginRequest(r2);
  assert.equal(begin.ok, true);
  const degraded = store.commit(
    {
      schema_version: SCHEMA_VERSION,
      request_id: 'r2',
      epoch: 1,
      base_graph_version: 0,
      input_version: ledger.input_version,
      status: 'degraded',
      reason: 'timeout',
      considered: [],
      ops: [],
      unresolved: [],
    },
    r2
  );
  assert.equal(degraded.ok, true);
  assert.equal(degraded.degraded, true);
  assert.equal(store.snapshot().receipts[s2], undefined);
});

test('人工纠正：改标签/撤回递增版本，不允许新建节点', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['用户流失是因为操作太复杂']);
  const request = buildRequest(store, ledger, 'r1');
  const sceneId = makeId('scene', 'r1', 1);
  const nid = makeId('node', 'r1', 2);
  respond(store, ledger, request, [
    scene('r1', 1, '流失原因'),
    node('r1', 2, sceneId, '操作太复杂', [evidence(s1, '操作太复杂')]),
  ]);
  const v = store.graphVersion;
  const fixed = store.applyManual([{ op: 'upsert_node', node: { id: nid, label: '入口找不到' } }]);
  assert.equal(fixed.ok, true, JSON.stringify(fixed.errors));
  assert.equal(store.snapshot().nodes[nid].label, '入口找不到');
  assert.equal(store.graphVersion, v + 1);

  const denied = store.applyManual([
    {
      op: 'upsert_node',
      node: { id: makeId('node', 'manual', 1), scene_id: sceneId, label: '凭空捏造', claim_kind: 'assertion' },
    },
  ]);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'manual_rejected');
});

test('场景容量提示但不静默删除节点；回看激活会归档上一场景', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['流程有五层：入口、选择、确认、提交、完成']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneA = makeId('scene', 'r1', 1);
  const ev = [evidence(s1, '流程有五层')];
  const ops = [scene('r1', 1, '流程', 'composition')];
  for (let i = 0; i < 7; i++) ops.push(node('r1', 10 + i, sceneA, `层 ${i + 1}`, ev));
  respond(store, ledger, r1, ops);
  assert.equal(store.sceneGraph(sceneA).nodes.length, 7);

  const r2 = buildRequest(store, ledger, 'r2');
  respond(store, ledger, r2, [scene('r2', 1, '补充说明', 'text'), { op: 'activate_scene', scene_id: makeId('scene', 'r2', 1) }]);
  assert.equal(store.snapshot().scenes[sceneA].status, 'archived');
  assert.equal(store.activeScene().id, makeId('scene', 'r2', 1));
  assert.equal(store.recentScenes().length, 1);
});

test('人工修正归档场景：当前场景不变，只递增一次版本并标 manual', () => {
  const { ledger, store } = makeEnv();
  const [s1, s2] = seedSegments(ledger, ['用户流失是因为操作太复杂', '先换界面，后来用户增长了，但还不确定关系']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneA = makeId('scene', 'r1', 1);
  const nodeA = makeId('node', 'r1', 2);
  respond(store, ledger, r1, [
    scene('r1', 1, '流失原因'),
    node('r1', 2, sceneA, '操作太复杂', [evidence(s1, '操作太复杂')]),
  ]);
  const r2 = buildRequest(store, ledger, 'r2');
  const sceneB = makeId('scene', 'r2', 1);
  respond(store, ledger, r2, [
    scene('r2', 1, '先后与不确定'),
    node('r2', 2, sceneB, '换了界面', [evidence(s2, '先换界面')]),
    node('r2', 3, sceneB, '用户增长', [evidence(s2, '用户增长了')]),
  ]);
  assert.equal(store.activeScene().id, sceneB);
  const before = store.graphVersion;

  const out = store.applyManual([{ op: 'upsert_node', node: { id: nodeA, label: '新用户找不到入口' } }]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(store.snapshot().nodes[nodeA].label, '新用户找不到入口');
  assert.equal(store.snapshot().nodes[nodeA].manual, true);
  assert.equal(store.graphVersion, before + 1);
  assert.equal(store.activeScene().id, sceneB, 'correcting an archived scene must not switch the active scene');
  assert.equal(store.snapshot().scenes[sceneA].status, 'archived');
  assert.equal(store.snapshot().scenes[sceneB].status, 'active');
  const view = store.graphView();
  assert.equal(view.nodes.find((n) => n.id === nodeA).manual, true);
  assert.equal(view.nodes.find((n) => n.id === nodeA).label, '新用户找不到入口');
});

test('人工撤回节点会级联撤回边，且整批只递增一次版本', () => {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['资料分散所以来回切换']);
  const r1 = buildRequest(store, ledger, 'r1');
  const sceneA = makeId('scene', 'r1', 1);
  const a = makeId('node', 'r1', 2);
  const b = makeId('node', 'r1', 3);
  const e = makeId('edge', 'r1', 4);
  const ev = [evidence(s1, '资料分散')];
  respond(store, ledger, r1, [
    scene('r1', 1, '因果'),
    node('r1', 2, sceneA, '资料分散', ev),
    node('r1', 3, sceneA, '来回切换', ev),
    edge('r1', 4, sceneA, a, b, 'causes', ev),
  ]);
  const before = store.graphVersion;
  const out = store.applyManual([{ op: 'retract', id: a }]);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(store.snapshot().nodes[a].state, 'retracted');
  assert.equal(store.snapshot().edges[e].state, 'retracted');
  assert.equal(store.graphVersion, before + 1);
});
