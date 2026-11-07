import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const runner = path.join(here, 'fixtures', 'asr-run.mjs');
const fake = path.join(here, 'fixtures', 'fake-asr.py');

function run(env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deck-asr-test-'));
  try {
    const r = spawnSync(process.execPath, [runner], {
      cwd: root,
      timeout: 15_000,
      encoding: 'utf8',
      env: { ...process.env, ASR_PYTHON: fake, FAKE_MARKER_DIR: dir, ...env },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('final 在 worker 退出后能重启并恢复', () => {
  const out = run({ ASR_FINAL_WORKER: '0', FAKE_CRASH: 'main' });
  assert.equal(out.dual, false);
  assert.match(out.first.error, /worker exited \(7\)/);
  assert.equal(out.second.text, 'main:ok');
  assert.equal(out.leftover, 0);
});

test('fast 崩溃后回退 main，且 main 能读到重建的 wav', () => {
  const out = run({ ASR_FINAL_WORKER: '1', FAKE_CRASH: 'fast' });
  assert.equal(out.dual, true);
  assert.equal(out.first.text, 'main:ok');
  assert.equal(out.second.text, 'main:ok');
  assert.equal(out.leftover, 0);
});
