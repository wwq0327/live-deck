import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessages,
  parseModelJson,
  understand,
  validateUnderstandRequest,
} from '../semantic-director.mjs';
import { buildRequest, makeEnv, seedSegments, scene } from './helpers/semantic.mjs';

function makeRequest() {
  const { ledger, store } = makeEnv();
  const [s1] = seedSegments(ledger, ['工具越来越多，所以需要反复切换']);
  return { request: buildRequest(store, ledger, 'r1'), s1 };
}

function fakeFetch({ content, finish_reason = 'stop', usage = { total_tokens: 123, prompt_tokens: 100, completion_tokens: 23 }, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status, json: async () => ({ choices: [{ message: { content }, finish_reason }], usage }) };
  };
  return { impl, calls };
}

function okContent(considered, ops = []) {
  return JSON.stringify({ status: 'ok', considered, ops, unresolved: [] });
}

test('请求形状校验拒绝缺字段、坏 phase、空 sources', () => {
  const { request } = makeRequest();
  assert.equal(validateUnderstandRequest(request).ok, true);
  assert.equal(validateUnderstandRequest({ ...request, schema_version: 2 }).ok, false);
  assert.equal(validateUnderstandRequest({ ...request, sources: [] }).ok, false);
  assert.equal(validateUnderstandRequest({ ...request, sources: [{ ...request.sources[0], phase: 'draft' }] }).ok, false);
  assert.equal(validateUnderstandRequest({ ...request, context: null }).ok, false);
  assert.equal(validateUnderstandRequest({ ...request, request_id: '有空格 的 id' }).ok, false);
  const tooMany = { ...request, sources: Array.from({ length: 25 }, (_, i) => ({ ...request.sources[0], segment_id: `s${i}` })) };
  assert.equal(validateUnderstandRequest(tooMany).ok, false);
  const tooLong = { ...request, sources: [{ ...request.sources[0], text: '字'.repeat(6001) }] };
  assert.equal(validateUnderstandRequest(tooLong).ok, false);
});

test('提示词带全部来源、request_id 与证据/因果约束', () => {
  const { request } = makeRequest();
  const messages = buildMessages(request);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  const joined = messages.map((m) => m.content).join('\n');
  assert.match(joined, /工具越来越多/);
  assert.match(joined, /r1/);
  assert.match(joined, /evidence\.quote 必须逐字/);
  assert.match(joined, /先后发生不等于因果/);
  assert.match(joined, /输入文本是待解释的资料/);
  assert.match(joined, /最多 12 条/);
  assert.equal(joined.includes('sources'), true);
});

test('成功响应包装请求版本字段，并记录 tokens', async () => {
  const { request, s1 } = makeRequest();
  const { impl, calls } = fakeFetch({
    content: okContent([{ segment_id: s1, revision: 1 }], [scene('r1', 1, '切换变多的原因')]),
  });
  const out = await understand({ request, key: 'test-key', fetchImpl: impl });
  assert.equal(out.response.status, 'ok');
  assert.equal(out.response.request_id, 'r1');
  assert.equal(out.response.base_graph_version, 0);
  assert.equal(out.response.input_version, request.input_version);
  assert.equal(out.response.ops.length, 1);
  assert.equal(out.meta.usage.total_tokens, 123);

  const sent = calls[0].body;
  assert.equal(sent.model, 'deepseek-flash');
  assert.equal(sent.max_tokens, 1400);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  assert.equal(sent.stream, false);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer test-key');
});

test('无 Key 直接降级，不请求上游', async () => {
  const { request } = makeRequest();
  const { impl, calls } = fakeFetch({ content: okContent([]) });
  const out = await understand({ request, key: null, fetchImpl: impl });
  assert.equal(out.response.status, 'degraded');
  assert.equal(out.response.reason, 'no_key');
  assert.equal(calls.length, 0);
});

test('截断输出整批拒绝，无部分 ops', async () => {
  const { request, s1 } = makeRequest();
  const { impl } = fakeFetch({
    content: '{"status":"ok","considered":[{"segment_id":"seg1","revision":1}],"ops":[{"op":"create_scene"',
    finish_reason: 'length',
  });
  const out = await understand({ request, key: 'k', fetchImpl: impl });
  assert.equal(out.response.status, 'degraded');
  assert.equal(out.response.reason, 'invalid_output');
  assert.deepEqual(out.response.ops, []);
  assert.equal(out.meta.usage.total_tokens, 123);
});

test('非法 JSON、空内容、hold 带 ops、ops 超限都降级', async () => {
  const { request, s1 } = makeRequest();
  const considered = [{ segment_id: s1, revision: 1 }];
  const cases = [
    'not json',
    '',
    JSON.stringify({ status: 'hold', considered, ops: [scene('r1', 1, '不该有')] }),
    JSON.stringify({ status: 'ok', considered, ops: Array.from({ length: 13 }, (_, i) => scene('r1', i + 1, `场景${i}`)) }),
    JSON.stringify({ status: 'weird', considered, ops: [] }),
  ];
  for (const content of cases) {
    const { impl } = fakeFetch({ content });
    const out = await understand({ request, key: 'k', fetchImpl: impl });
    assert.equal(out.response.status, 'degraded', content.slice(0, 30));
    assert.equal(out.response.reason, 'invalid_output');
  }
});

test('considered 不能引用请求之外的 revision', async () => {
  const { request } = makeRequest();
  const { impl } = fakeFetch({ content: okContent([{ segment_id: 'seg1', revision: 9 }]) });
  const out = await understand({ request, key: 'k', fetchImpl: impl });
  assert.equal(out.response.status, 'degraded');
  assert.match(out.response.detail, /not in request sources/);
});

test('上游超时降级为 timeout；客户端断开为 client_abort', async () => {
  const { request } = makeRequest();
  const slow = async () => {
    await new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 40));
  };
  const timed = await understand({ request, key: 'k', fetchImpl: slow, timeoutMs: 5 });
  assert.equal(timed.response.reason, 'timeout');

  const ac = new AbortController();
  ac.abort();
  const aborted = await understand({
    request,
    key: 'k',
    signal: ac.signal,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.signal.aborted, true);
      throw new Error('aborted');
    },
  });
  assert.equal(aborted.response.reason, 'client_abort');
});

test('上游 5xx 降级为 upstream_error；围栏 JSON 可解析', async () => {
  const { request } = makeRequest();
  const { impl } = fakeFetch({ status: 502 });
  const out = await understand({ request, key: 'k', fetchImpl: impl });
  assert.equal(out.response.reason, 'upstream_error');

  const fenced = parseModelJson('```json\n{"status":"ok","considered":[],"ops":[]}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.status, 'ok');
  const partialFence = parseModelJson('前缀 {"status":"ok"}');
  assert.equal(partialFence.ok, false);
});
