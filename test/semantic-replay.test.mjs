import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptLedger } from '../public/semantic/transcript.js';
import { ScenarioPlayer } from '../public/semantic/replay.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/semantic/', import.meta.url));

async function loadScenarios() {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const file of files) {
    const mod = await import(join(FIXTURE_DIR, file));
    out.push({ file, scenario: mod.default });
  }
  return out;
}

test('验收场景目录覆盖 C01—C14（C10 为 60 秒生成场景）', async () => {
  const scenarios = await loadScenarios();
  const ids = scenarios.map((s) => s.scenario.id);
  for (let i = 1; i <= 14; i++) {
    assert.ok(ids.includes(`C${String(i).padStart(2, '0')}`), `missing C${i}`);
  }
  const c10 = scenarios.find((s) => s.scenario.id === 'C10').scenario;
  assert.equal(c10.duration_ms, 60000);
  assert.equal(c10.events.length, 240);
});

test('每个场景按模拟时间开放事件，checkpoints 全部通过', async () => {
  const scenarios = await loadScenarios();
  for (const { scenario } of scenarios) {
    const ledger = new TranscriptLedger({ epoch: 1, now: () => 0 });
    const player = new ScenarioPlayer({ scenario, ledger });
    const results = player.checkpoints();
    for (const result of results) {
      assert.equal(result.ok, true, `${scenario.id} @${result.at_ms}ms: ${result.failures.join('; ')}`);
    }
    // 不得提前释放未来事件
    const maxSeen = Math.max(0, ...player.released.map((r) => r.at_ms));
    assert.ok(maxSeen <= player.timeMs, `${scenario.id} released future event at ${maxSeen} > ${player.timeMs}`);
  }
});

test('不静默丢 final：重置点之后的每个 final 都成为当前内容', async () => {
  const scenarios = await loadScenarios();
  for (const { scenario } of scenarios) {
    const ledger = new TranscriptLedger({ epoch: 1, now: () => 0 });
    const player = new ScenarioPlayer({ scenario, ledger });
    player.run();
    const resets = player.controls.filter((c) => c.control === 'reset').map((c) => c.at_ms);
    const lastReset = resets.length ? resets[resets.length - 1] : -1;
    const expectedFinals = scenario.events
      .filter((e) => e.event && e.event.phase === 'final' && e.at_ms > lastReset)
      .map((e) => e.event.text);
    const current = ledger.segments({ phase: 'final' }).map((s) => s.text);
    assert.deepEqual(current, expectedFinals, `${scenario.id} final 内容被改写或丢失`);
    for (const segment of ledger.segments()) {
      const lastEvent = scenario.events
        .filter((e) => e.event && e.event.segment_id === segment.segment_id && e.at_ms > lastReset)
        .at(-1);
      if (lastEvent) {
        const sealedAfter = lastEvent.event.phase === 'final' || ledger.segments().some((s) => s.segment_id === segment.segment_id);
        assert.ok(sealedAfter);
      }
    }
  }
});

test('final 前的请求只能看到已开放文本（不泄漏未来）', async () => {
  const mod = await import(join(FIXTURE_DIR, 'c01.mjs'));
  const scenario = mod.default;
  const ledger = new TranscriptLedger({ epoch: 1, now: () => 0 });
  const player = new ScenarioPlayer({ scenario, ledger });
  player.advanceTo(2500);
  const visible = ledger.buildSources();
  const joined = visible.sources.map((s) => s.text).join('\n');
  assert.ok(joined.includes('来回切换'));
  assert.equal(joined.includes('切换让我花更多时间'), false, '未来 final 不得提前可见');
  assert.equal(visible.sources.length, 1);
  assert.equal(visible.sources[0].phase, 'partial');
});

test('迟到 partial 与同 revision 冲突都被记录，不改变 final', async () => {
  const mod = await import(join(FIXTURE_DIR, 'c02.mjs'));
  const scenario = mod.default;
  const ledger = new TranscriptLedger({ epoch: 1, now: () => 0 });
  const player = new ScenarioPlayer({ scenario, ledger });
  player.run();
  assert.equal(player.rejects.length, 1);
  assert.equal(player.rejects[0].code, 'late_revision');
  assert.equal(ledger.segments()[0].text, '这个办法不能减少切换');
  assert.equal(ledger.segments()[0].phase, 'final');
});
