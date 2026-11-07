import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticPresenter } from '../public/semantic/presenter.js';

function fakes() {
  const state = {
    active_scene_id: 's2',
    scenes: {
      s1: { id: 's1', title: '旧场景', family: 'cause' },
      s2: { id: 's2', title: '当前场景', family: 'compare' },
    },
    nodes: { n1: { id: 'n1', label: '旧标签', claim_kind: 'assertion', scene_id: 's2' } },
    edges: { e1: { id: 'e1', relation: 'causes', label: '', scene_id: 's2' } },
  };
  const renderCalls = [];
  const sceneCalls = [];
  const manualCalls = [];
  const store = {
    snapshot: () => structuredClone(state),
    applyManual: (ops) => {
      manualCalls.push(ops);
      return { ok: true, committed: true };
    },
  };
  const renderer = {
    sceneId: 's2',
    render: (s, o) => {
      renderCalls.push({ state: structuredClone(s), options: o || {} });
      return true;
    },
    showScene: (id) => sceneCalls.push(id),
  };
  return { store, renderer, renderCalls, sceneCalls, manualCalls, state };
}

test('保持画面时提交只进 Store，不重绘；恢复直接渲染最新一次', () => {
  const { store, renderer, renderCalls } = fakes();
  const statuses = [];
  const p = new SemanticPresenter({ store, renderer, onStatus: (s) => statuses.push(s) });
  assert.equal(p.hold(), true);
  p.render({ active_scene_id: 's2', scenes: {}, nodes: {}, edges: {} });
  p.render({ active_scene_id: 's2', scenes: {}, nodes: {}, edges: {} });
  assert.equal(renderCalls.length, 0);
  assert.equal(p.skipped, 2);
  assert.equal(p.resume(), true);
  assert.equal(renderCalls.length, 1);
  assert.deepEqual(renderCalls[0].options, { animate: false, reason: 'resume' });
  assert.equal(renderCalls[0].state.active_scene_id, 's2');
  assert.deepEqual(statuses, ['held', 'resumed']);
});

test('保持是幂等的，恢复后再提交会正常重绘', () => {
  const { store, renderer, renderCalls } = fakes();
  const p = new SemanticPresenter({ store, renderer });
  assert.equal(p.hold(), true);
  assert.equal(p.hold(), false);
  p.resume();
  p.resume();
  p.render({ active_scene_id: 's2', scenes: {}, nodes: {}, edges: {} });
  assert.equal(renderCalls.length, 2);
  assert.equal(renderCalls[1].options.animate, undefined);
});

test('回看只 pin 归档场景，不回写 active_scene_id', () => {
  const { store, renderer, sceneCalls } = fakes();
  const p = new SemanticPresenter({ store, renderer });
  assert.equal(p.pin('s1'), true);
  assert.deepEqual(sceneCalls, ['s1']);
  assert.equal(p.pinned, true);
  assert.equal(p.store.snapshot().active_scene_id, 's2');
  assert.equal(p.pin('missing'), false);
  assert.equal(p.unpin(), true);
  assert.deepEqual(sceneCalls, ['s1', null]);
});

test('人工改文字走 applyManual 并在提交后无动画重绘', () => {
  const { store, renderer, renderCalls, manualCalls } = fakes();
  const p = new SemanticPresenter({ store, renderer });
  const r = p.editNode('n1', { label: '新标签', claim_kind: 'hypothesis' });
  assert.equal(r.ok, true);
  assert.deepEqual(manualCalls[0], [{ op: 'upsert_node', node: { id: 'n1', label: '新标签', claim_kind: 'hypothesis' } }]);
  assert.equal(renderCalls[0].options.reason, 'manual');
  assert.equal(renderCalls[0].options.animate, false);
});

test('人工改关系与撤回也只走手动通道', () => {
  const { store, renderer, renderCalls, manualCalls } = fakes();
  const p = new SemanticPresenter({ store, renderer });
  p.editEdge('e1', { relation: 'contrasts', label: '共同维度' });
  p.retract('n1');
  assert.deepEqual(manualCalls[0], [{ op: 'upsert_edge', edge: { id: 'e1', label: '共同维度', relation: 'contrasts' } }]);
  assert.deepEqual(manualCalls[1], [{ op: 'retract', id: 'n1', reason: 'manual' }]);
  assert.equal(renderCalls.length, 2);
});

test('不存在的对象不写 Store、不重绘', () => {
  const { store, renderer, renderCalls, manualCalls } = fakes();
  const p = new SemanticPresenter({ store, renderer });
  const r = p.editNode('nope', { label: 'x' });
  assert.equal(r.ok, false);
  assert.equal(manualCalls.length, 0);
  assert.equal(renderCalls.length, 0);
});
