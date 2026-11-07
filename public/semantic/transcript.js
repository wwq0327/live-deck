// 版本化转写账本：partial 前缀替换、final 封口、迟到与乱序事件、来源查询。
// 纯 ESM，无 DOM 依赖。协议见 docs/plans/.../protocol.md「输入账本」。
import { LIMITS, PHASES, isInt, isObject, isText, oneOf } from './protocol.js';

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const fail = (code, reason) => ({ ok: false, applied: false, changed: false, code, reason, invalidations: [] });

function snapshotEntry(entry) {
  return {
    segment_id: entry.segment_id,
    order: entry.order,
    revision: entry.revision,
    phase: entry.phase,
    text: entry.text,
    speaker_id: entry.speaker_id,
    audio_start_ms: entry.audio_start_ms,
    audio_end_ms: entry.audio_end_ms,
    received_at_ms: entry.received_at_ms,
    sealed: entry.sealed,
  };
}

export class TranscriptLedger {
  constructor({ epoch = 1, now = () => Date.now() } = {}) {
    this.epoch = epoch;
    this.now = now;
    this.entries = new Map();
    this.receipts = new Map();
    this.inputVersion = 0;
    this.lastOrder = 0;
    this.invalidationsTotal = 0;
    this.conflicts = [];
    this.listeners = new Set();
  }

  get input_version() {
    return this.inputVersion;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(result) {
    for (const fn of this.listeners) {
      try {
        fn(result, this);
      } catch {
        /* ignore observer errors */
      }
    }
  }

  reset({ epoch = this.epoch + 1 } = {}) {
    this.epoch = epoch;
    this.entries.clear();
    this.receipts.clear();
    this.inputVersion = 0;
    this.lastOrder = 0;
    this.invalidationsTotal = 0;
    this.conflicts = [];
  }

  nextOrder() {
    return this.lastOrder + 1;
  }

  nextRevision(segmentId) {
    const entry = this.entries.get(segmentId);
    return entry ? entry.revision + 1 : 1;
  }

  /**
   * 接收一条输入事件。
   * event: {kind:'transcript', epoch, segment_id, order, revision, phase, text, speaker_id?, audio_start_ms?, audio_end_ms?}
   * 返回 {ok, applied, changed, duplicate?, code?, reason?, invalidations:[{segment_id, revision, reason}]}
   */
  ingest(event) {
    if (!isObject(event)) return fail('invalid_event', 'event must be an object');
    if (event.kind !== undefined && event.kind !== 'transcript') return fail('invalid_event', 'kind must be transcript');
    if (!isInt(event.epoch, 1)) return fail('invalid_event', 'epoch invalid');
    if (event.epoch !== this.epoch) {
      return fail(event.epoch < this.epoch ? 'stale_epoch' : 'epoch_mismatch', `event epoch ${event.epoch} != ${this.epoch}`);
    }
    if (!isText(event.segment_id, 64)) return fail('invalid_event', 'segment_id invalid');
    if (!isInt(event.revision, 1)) return fail('invalid_event', 'revision invalid');
    if (!oneOf(event.phase, PHASES)) return fail('invalid_event', 'phase invalid');
    if (typeof event.text !== 'string') return fail('invalid_event', 'text must be a string');
    const text = event.text.trim();
    if (!text) return { ...fail('empty_text', 'empty transcript ignored'), ok: true };

    let order = event.order;
    if (order === undefined) order = this.lastOrder + 1;
    if (!isInt(order, 1)) return fail('invalid_event', 'order invalid');
    const speaker = typeof event.speaker_id === 'string' ? event.speaker_id.slice(0, LIMITS.maxSpeaker) : 'unknown';
    const received = Number.isFinite(event.received_at_ms) ? event.received_at_ms : this.now();

    const existing = this.entries.get(event.segment_id);
    if (!existing) {
      if (event.revision > 1 && event.phase === 'partial') {
        // 没收到 rev1 就来了 rev2：记录但标异常，交给后续 final 校正。
        this.conflicts.push({ at: received, segment_id: event.segment_id, problem: 'partial without prior revision' });
      }
      const entry = {
        segment_id: event.segment_id,
        order,
        revision: event.revision,
        phase: event.phase,
        text,
        speaker_id: speaker,
        audio_start_ms: Number.isFinite(event.audio_start_ms) ? event.audio_start_ms : null,
        audio_end_ms: Number.isFinite(event.audio_end_ms) ? event.audio_end_ms : null,
        received_at_ms: received,
        sealed: event.phase === 'final',
        revisions: [{ revision: event.revision, phase: event.phase, text, received_at_ms: received }],
      };
      this.entries.set(entry.segment_id, entry);
      this.lastOrder = Math.max(this.lastOrder, order);
      this.inputVersion += 1;
      const result = {
        ok: true,
        applied: true,
        changed: true,
        input_version: this.inputVersion,
        invalidations: [],
        entry: snapshotEntry(entry),
      };
      this.#emit(result);
      return result;
    }

    if (existing.order !== order) {
      this.conflicts.push({ at: received, segment_id: event.segment_id, problem: `order ${order} != ${existing.order}` });
      return fail('order_conflict', `segment ${event.segment_id} order mismatch`);
    }
    if (existing.speaker_id !== 'unknown' && speaker !== 'unknown' && existing.speaker_id !== speaker) {
      return fail('speaker_conflict', `segment ${event.segment_id} speaker mismatch`);
    }

    const cur = existing.revision;
    const sameText = text === existing.text;
    const invalidations = [];

    if (event.revision < cur) {
      this.conflicts.push({
        at: received,
        segment_id: event.segment_id,
        problem: `late revision ${event.revision} < ${cur}`,
      });
      return fail('late_revision', `revision ${event.revision} is older than ${cur}`);
    }

    if (event.revision === cur) {
      if (event.phase === existing.phase) {
        if (sameText) {
          return {
            ok: true,
            applied: false,
            changed: false,
            duplicate: true,
            input_version: this.inputVersion,
            invalidations: [],
            entry: snapshotEntry(existing),
          };
        }
        this.conflicts.push({
          at: received,
          segment_id: event.segment_id,
          problem: `text changed without revision bump (${cur})`,
        });
        return fail('revision_conflict', `text changed at same revision ${cur}`);
      }
      if (event.phase === 'partial' && existing.phase === 'final') {
        this.conflicts.push({ at: received, segment_id: event.segment_id, problem: 'late partial after final' });
        return fail('sealed', 'final already sealed this segment');
      }
      // partial -> final at same revision：封口。旧草稿文本留档，供历史查询。
      if (existing.text !== text) {
        existing.revisions.push({ revision: cur, phase: existing.phase, text: existing.text, received_at_ms: received });
      }
      existing.phase = 'final';
      existing.sealed = true;
      existing.text = text;
      existing.received_at_ms = received;
      this.inputVersion += 1;
      invalidations.push({ segment_id: event.segment_id, revision: cur, reason: 'partial promoted to final' });
      const result = {
        ok: true,
        applied: true,
        changed: true,
        input_version: this.inputVersion,
        invalidations,
        entry: snapshotEntry(existing),
      };
      this.invalidationsTotal += invalidations.length;
      this.#emit(result);
      return result;
    }

    // revision > cur
    if (existing.phase === 'final' && event.phase === 'partial') {
      this.conflicts.push({ at: received, segment_id: event.segment_id, problem: 'late partial after final' });
      return fail('sealed', 'higher-revision partial cannot overwrite a final');
    }
    if (existing.phase === 'final' && event.phase === 'final' && sameText) {
      return fail('duplicate_final', 'duplicate final text at higher revision');
    }

    // 接受：partial 覆盖草稿，或更高 revision 的 final 纠正已封口段。
    existing.revisions.push({
      revision: existing.revision,
      phase: existing.phase,
      text: existing.text,
      received_at_ms: existing.received_at_ms,
    });
    invalidations.push({
      segment_id: event.segment_id,
      revision: existing.revision,
      reason: event.phase === 'final' && existing.phase === 'final' ? 'final corrected' : 'draft replaced',
    });
    existing.revision = event.revision;
    existing.phase = event.phase;
    existing.text = text;
    existing.received_at_ms = received;
    existing.sealed = event.phase === 'final';
    if (existing.speaker_id === 'unknown' && speaker !== 'unknown') existing.speaker_id = speaker;
    this.inputVersion += 1;
    this.invalidationsTotal += invalidations.length;
    const result = {
      ok: true,
      applied: true,
      changed: true,
      input_version: this.inputVersion,
      invalidations,
      entry: snapshotEntry(existing),
    };
    this.#emit(result);
    return result;
  }

  current(segmentId) {
    const entry = this.entries.get(segmentId);
    return entry ? snapshotEntry(entry) : null;
  }

  isCurrent(segmentId, revision) {
    const entry = this.entries.get(segmentId);
    return Boolean(entry) && entry.revision === revision;
  }

  getRevision(segmentId, revision) {
    const entry = this.entries.get(segmentId);
    if (!entry) return null;
    if (entry.revision === revision) return snapshotEntry(entry);
    const past = entry.revisions.find((r) => r.revision === revision);
    if (!past) return null;
    return {
      segment_id: entry.segment_id,
      order: entry.order,
      revision: past.revision,
      phase: past.phase,
      text: past.text,
      speaker_id: entry.speaker_id,
      received_at_ms: past.received_at_ms,
      superseded: true,
    };
  }

  segments({ phase } = {}) {
    return [...this.entries.values()]
      .filter((e) => (phase ? e.phase === phase : true))
      .sort((a, b) => a.order - b.order)
      .map(snapshotEntry);
  }

  receipts() {
    return Object.fromEntries(this.receipts);
  }

  markConsumed(considered) {
    let changed = false;
    for (const item of considered || []) {
      if (!item || !isText(item.segment_id, 64) || !isInt(item.revision, 1)) continue;
      if (!this.isCurrent(item.segment_id, item.revision)) continue;
      if (this.receipts.get(item.segment_id) === item.revision) continue;
      this.receipts.set(item.segment_id, item.revision);
      changed = true;
    }
    return changed;
  }

  isConsumed(segmentId) {
    const entry = this.entries.get(segmentId);
    return Boolean(entry) && this.receipts.get(segmentId) === entry.revision;
  }

  unconsumedFinals() {
    return this.segments({ phase: 'final' }).filter((e) => this.receipts.get(e.segment_id) !== e.revision);
  }

  latestPartial() {
    const partials = this.segments({ phase: 'partial' });
    return partials.length ? partials[partials.length - 1] : null;
  }

  pendingCount() {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (this.receipts.get(entry.segment_id) !== entry.revision) n += 1;
    }
    return n;
  }

  hasPendingInput() {
    return this.pendingCount() > 0;
  }

  oldestPendingAgeMs(nowMs = this.now()) {
    let oldest = null;
    for (const entry of this.entries.values()) {
      if (this.receipts.get(entry.segment_id) === entry.revision) continue;
      const age = nowMs - entry.received_at_ms;
      if (oldest === null || age > oldest) oldest = age;
    }
    return oldest;
  }

  /**
   * 组装本次请求可见的 sources。未消费 final 全保留（超出上限时截断并报告 backlog），
   * 最新 partial 总在；其余已消费原文只取最近窗口，仅作证据/代词上下文。
   */
  buildSources({ nowMs = this.now(), maxSources = LIMITS.maxSources, maxChars = LIMITS.maxSourceChars } = {}) {
    const all = this.segments();
    const finals = all.filter((e) => e.phase === 'final' && this.receipts.get(e.segment_id) !== e.revision);
    const latest = this.latestPartial();
    const selected = [];
    const seen = new Set();
    let chars = 0;
    let droppedFinals = 0;

    const push = (entry) => {
      const key = `${entry.segment_id}@${entry.revision}`;
      if (seen.has(key)) return true;
      if (selected.length >= maxSources || chars + entry.text.length > maxChars) return false;
      seen.add(key);
      selected.push({
        segment_id: entry.segment_id,
        revision: entry.revision,
        order: entry.order,
        phase: entry.phase,
        speaker_id: entry.speaker_id,
        text: entry.text,
      });
      chars += entry.text.length;
      return true;
    };

    const reserve = latest ? 1 : 0;
    for (const entry of finals) {
      if (selected.length >= maxSources - reserve || chars + entry.text.length > maxChars) {
        droppedFinals += 1;
        continue;
      }
      push(entry);
    }
    if (latest) {
      if (!push(latest) && selected.length < maxSources) {
        // 单段草稿本身超预算：截断后仍要送达，避免模型完全看不到正在说的话。
        const cut = latest.text.slice(0, Math.max(0, maxChars - chars));
        if (cut) {
          seen.add(`${latest.segment_id}@${latest.revision}`);
          selected.push({
            segment_id: latest.segment_id,
            revision: latest.revision,
            order: latest.order,
            phase: latest.phase,
            speaker_id: latest.speaker_id,
            text: cut,
            truncated: true,
          });
          chars += cut.length;
        }
      }
    }

    // 已消费的最近原文：从新到旧补进窗口，供代词、回指与既有证据使用。
    const consumed = all
      .filter((e) => this.receipts.get(e.segment_id) === e.revision)
      .filter((e) => (e.segment_id !== latest?.segment_id || e.revision !== latest?.revision))
      .filter((e) => nowMs - e.received_at_ms <= LIMITS.contextWindowMs);
    for (let i = consumed.length - 1; i >= 0; i--) {
      if (selected.length >= maxSources) break;
      if (chars + consumed[i].text.length > maxChars) continue;
      if (!push(consumed[i])) break;
    }

    selected.sort((a, b) => a.order - b.order);
    return {
      sources: selected,
      chars,
      droppedFinals,
      backlog: {
        finals: finals.length,
        dropped: droppedFinals,
        ageMs: this.oldestPendingAgeMs(nowMs),
      },
    };
  }

  summary(nowMs = this.now()) {
    const finals = this.unconsumedFinals();
    const latest = this.latestPartial();
    return {
      epoch: this.epoch,
      input_version: this.inputVersion,
      segments: this.entries.size,
      consumed: this.receipts.size,
      unconsumed_finals: finals.length,
      oldest_pending_ms: this.oldestPendingAgeMs(nowMs),
      latest_partial: latest ? latest.text.slice(0, 80) : null,
      conflicts: this.conflicts.slice(-5),
    };
  }
}
