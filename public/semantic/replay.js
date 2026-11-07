// 验收场景回放：事件按模拟时间逐条开放给账本，绝不提前把未来文字交给下游。
// 纯 ESM，可在 node --test 与浏览器诊断页复用。
import { isInt, isObject } from './protocol.js';

const CONTROL_ACTIONS = new Set(['reset', 'hold', 'resume']);

export class ScenarioPlayer {
  constructor({ scenario, ledger, onRelease } = {}) {
    if (!isObject(scenario)) throw new Error('scenario required');
    if (!ledger) throw new Error('ledger required');
    this.scenario = scenario;
    this.ledger = ledger;
    this.onRelease = onRelease || null;
    this.durationMs = isInt(scenario.duration_ms, 0) ? scenario.duration_ms : 0;
    this.events = (scenario.events || [])
      .map((item, index) => ({ ...item, index }))
      .sort((a, b) => (a.at_ms - b.at_ms) || (a.index - b.index));
    for (const item of this.events) {
      if (!isInt(item.at_ms, 0)) throw new Error(`scenario ${scenario.id}: event.at_ms invalid`);
      if (item.at_ms > this.durationMs) this.durationMs = item.at_ms;
    }
    this.cursor = 0;
    this.timeMs = 0;
    this.released = [];
    this.rejects = [];
    this.controls = [];
    this.epoch = ledger.epoch;
  }

  get pendingEvents() {
    return this.events.length - this.cursor;
  }

  /** 只开放 at_ms <= ms 的事件；已开放的不重放。 */
  advanceTo(ms) {
    if (!isInt(ms, 0)) throw new Error('advanceTo: ms invalid');
    this.timeMs = Math.max(this.timeMs, ms);
    while (this.cursor < this.events.length && this.events[this.cursor].at_ms <= this.timeMs) {
      this.#release(this.events[this.cursor]);
      this.cursor += 1;
    }
    return this;
  }

  #release(item) {
    const control = item.control || (item.event && item.event.control);
    if (control) {
      if (!CONTROL_ACTIONS.has(control)) throw new Error(`scenario unknown control ${control}`);
      const record = { at_ms: item.at_ms, control };
      if (control === 'reset') {
        this.ledger.reset({ epoch: this.ledger.epoch + 1 });
        record.epoch = this.ledger.epoch;
      }
      this.controls.push(record);
      this.released.push(record);
      if (this.onRelease) this.onRelease(record, this);
      return;
    }
    const event = item.event;
    if (!isObject(event)) throw new Error(`scenario ${this.scenario.id}: event missing at ${item.at_ms}ms`);
    const enriched = { ...event, epoch: isInt(event.epoch, 1) ? event.epoch : this.ledger.epoch };
    const result = this.ledger.ingest(enriched);
    const record = {
      at_ms: item.at_ms,
      segment_id: event.segment_id,
      revision: event.revision,
      phase: event.phase,
      ok: result.ok,
      applied: result.applied,
      code: result.code || null,
    };
    this.released.push(record);
    if (!result.ok) this.rejects.push({ ...record, reason: result.reason });
    if (this.onRelease) this.onRelease(record, this);
  }

  run() {
    this.advanceTo(this.durationMs);
    return this.summary();
  }

  summary() {
    const finalTexts = this.ledger.segments({ phase: 'final' }).map((s) => s.text);
    return {
      id: this.scenario.id,
      time_ms: this.timeMs,
      segments: this.ledger.segments().length,
      final_texts: finalTexts,
      pending_finals: this.ledger.unconsumedFinals().length,
      input_version: this.ledger.input_version,
      rejects: this.rejects,
      controls: this.controls,
    };
  }

  /** 输入层断言：只证明信息被正确接收/替换/封口，不假装理解语义。 */
  checkpoints() {
    const results = [];
    const sorted = [...(this.scenario.checkpoints || [])].sort((a, b) => a.at_ms - b.at_ms);
    for (const cp of sorted) {
      this.advanceTo(cp.at_ms);
      const expect = cp.expect || {};
      const failures = [];
      const finals = this.ledger.segments({ phase: 'final' });
      if (expect.segment_count !== undefined && this.ledger.segments().length !== expect.segment_count) {
        failures.push(`segment_count ${this.ledger.segments().length} != ${expect.segment_count}`);
      }
      if (expect.final_texts !== undefined) {
        const got = finals.map((s) => s.text);
        if (JSON.stringify(got) !== JSON.stringify(expect.final_texts)) {
          failures.push(`final_texts ${JSON.stringify(got)} != ${JSON.stringify(expect.final_texts)}`);
        }
      }
      if (expect.input_version !== undefined && this.ledger.input_version !== expect.input_version) {
        failures.push(`input_version ${this.ledger.input_version} != ${expect.input_version}`);
      }
      if (expect.pending_count !== undefined && this.ledger.pendingCount() !== expect.pending_count) {
        failures.push(`pending_count ${this.ledger.pendingCount()} != ${expect.pending_count}`);
      }
      if (expect.rejected_codes !== undefined) {
        const seen = new Set(this.rejects.filter((r) => r.at_ms <= cp.at_ms).map((r) => r.code));
        for (const code of expect.rejected_codes) {
          if (!seen.has(code)) failures.push(`missing reject ${code}`);
        }
      }
      if (expect.no_text_loss) {
        const current = this.ledger.segments().map((s) => s.text);
        for (const final of finals) {
          if (!current.some((text) => text === final.text)) failures.push(`lost final ${final.segment_id}`);
        }
      }
      results.push({ at_ms: cp.at_ms, ok: failures.length === 0, failures });
    }
    return results;
  }
}

/** 事件脚本里的 final 文本集合，用于测试断言「不丢 final」。 */
export function finalEvents(scenario) {
  return (scenario.events || [])
    .filter((e) => e.event && e.event.phase === 'final')
    .map((e) => ({ segment_id: e.event.segment_id, revision: e.event.revision, text: e.event.text }));
}
