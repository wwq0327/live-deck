import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, heuristic } from '../director.mjs';

test('normalize 保留 stats，并裁到三项', () => {
  const out = normalize({
    action: 'new_slide',
    layout: 'stats',
    title: '三个数字',
    stats: [
      { value: 10, unit: '万', label: '日活' },
      { value: 40, unit: '%', label: '留存' },
      { value: 1, unit: '秒', label: '延迟' },
      { value: 99, unit: '个', label: '多余' },
    ],
  });
  assert.equal(out.action, 'new_slide');
  assert.equal(out.layout, 'stats');
  assert.equal(out.stats.length, 3);
  assert.deepEqual(out.stats[0], { value: '10', unit: '万', label: '日活' });
});

test('只有 stats 也算有内容，不能判成 noop', () => {
  const out = normalize({ action: 'new_slide', layout: 'stats', stats: [{ value: '2', unit: '倍' }] });
  assert.equal(out.action, 'new_slide');
});

test('空 new_slide 变成 noop；带 add_points 的 patch 保留', () => {
  assert.equal(normalize({ action: 'new_slide', title: '' }).action, 'noop');
  const patch = normalize({ action: 'patch', add_points: ['补一行'] });
  assert.equal(patch.action, 'patch');
  assert.deepEqual(patch.add_points, ['补一行']);
});

test('坏输入不抛异常', () => {
  assert.equal(normalize(null).action, 'noop');
  assert.equal(normalize([]).action, 'noop');
});

test('heuristic 能覆盖数字、对比、步骤和长句', () => {
  assert.equal(heuristic({ transcript: '日活 10 万' }).layout, 'stat');
  const stats = heuristic({ transcript: '日活10万，留存40%，延迟1秒' });
  assert.equal(stats.layout, 'stats');
  assert.equal(stats.stats.length, 3);
  assert.deepEqual(stats.stats[1], { value: '40', unit: '%', label: '留存' });
  assert.equal(heuristic({ transcript: '以前很慢，现在很快' }).layout, 'compare');
  assert.equal(heuristic({ transcript: '第一步先听，第二步再想' }).layout, 'steps');
  assert.equal(heuristic({ transcript: '这是一句很短的话' }).layout, 'bigidea');
  assert.equal(heuristic({ transcript: '这个事情我们做了很久，中间遇到很多问题，后来终于解决了，也学到了不少东西' }).layout, 'bullets');
  assert.doesNotThrow(() => heuristic({}));
});
