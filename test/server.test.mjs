import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4527;
let child;
let home;
let output = '';

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error('server exited:\n' + output);
    try {
      const r = await request('/api/health');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready:\n' + output);
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'deck-test-'));
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOME: home,
      DEEPSEEK_API_KEY: '',
      ASR_PYTHON: '/bin/true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (home) await rm(home, { recursive: true, force: true });
});

test('health 正常返回', async () => {
  const r = await request('/api/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('health 暴露 ASR worker 状态', async () => {
  const r = await request('/api/health');
  const body = JSON.parse(r.body);
  assert.equal(body.asr.dual, false);
  assert.equal(body.asr.fastReady, false);
});

test('拒绝非本机 Host（DNS rebinding）', async () => {
  const r = await request('/api/health', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 403);
});

test('非法 JSON 返回 400，不是 500', async () => {
  const r = await request('/api/direct', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /invalid JSON/);
});

test('拒绝跨站 Origin', async () => {
  const r = await request('/api/direct', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ transcript: '你好' }),
  });
  assert.equal(r.status, 403);
});

test('拒绝 non-JSON content-type', async () => {
  const r = await request('/api/direct', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ transcript: '你好' }),
  });
  assert.equal(r.status, 415);
});

test('合法请求在无 Key 时走本地规则', async () => {
  const r = await request('/api/direct', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: '日活 10 万' }),
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.source, 'heuristic');
  assert.equal(body.layout, 'stat');
  assert.equal(body.stat.value, '10');
});

test('流式接口在无 Key 时也返回 done 事件', async () => {
  const r = await request('/api/direct/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: '日活 10 万' }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/x-ndjson/);
  const lines = r.body.trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));
  const done = lines.find((x) => x.type === 'done');
  assert.ok(done);
  assert.equal(done.result.source, 'heuristic');
  assert.equal(done.result.layout, 'stat');
});

test('HEAD 不写 body，wav 有正确 MIME', async () => {
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const wav = await request('/sample.wav');
  assert.equal(wav.status, 200);
  assert.equal(wav.headers['content-type'], 'audio/wav');
});

function understandBody(over = {}) {
  return {
    schema_version: 1,
    request_id: 'r1',
    epoch: 1,
    base_graph_version: 0,
    input_version: 1,
    sources: [
      {
        segment_id: 'seg1',
        revision: 1,
        order: 1,
        phase: 'final',
        speaker_id: 'unknown',
        text: '工具越来越多，所以需要反复切换',
      },
    ],
    context: { active_scene: null, nodes: [], edges: [], recent_scenes: [], unresolved: [] },
    ...over,
  };
}

test('POST /api/understand 无 Key 时明确降级，不伪造图操作', async () => {
  const r = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(understandBody()),
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.status, 'degraded');
  assert.equal(body.reason, 'no_key');
  assert.deepEqual(body.ops, []);
  assert.deepEqual(body.considered, []);
  assert.equal(body.request_id, 'r1');
  assert.equal(body.base_graph_version, 0);
});

test('POST /api/understand 拒绝非法请求形状', async () => {
  const bad = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(understandBody({ schema_version: 2 })),
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /schema_version/);

  const empty = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(understandBody({ sources: [] })),
  });
  assert.equal(empty.status, 400);

  const broken = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(broken.status, 400);
});

test('POST /api/understand 沿用本机 Origin 与体积边界', async () => {
  const cross = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify(understandBody()),
  });
  assert.equal(cross.status, 403);

  const huge = await request('/api/understand', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(understandBody({ padding: 'x'.repeat(600 * 1024) })),
  });
  assert.equal(huge.status, 413);
});
