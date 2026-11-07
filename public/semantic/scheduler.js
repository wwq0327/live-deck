/**
 * Continuous scheduler: turns ledger changes into at most one in-flight
 * /api/understand request, merges rapid input, and commits response batches
 * atomically. Failed or conflicting batches are rejected whole and either
 * retried once (transient) or recomputed against the latest state.
 */

const DEFAULT_CONFIG = {
  debounceMs: 300,
  maxWaitMs: 800,
  clientTimeoutMs: 6000,
  retryDelayMs: 150,
  retryTransient: true,
  maxRecompute: 3,
  recomputeBackoffMs: 400,
  maxEvents: 400,
  requestIdPrefix: 'r',
  endpoint: '/api/understand',
};

const TRANSIENT = new Set(['timeout', 'upstream_error']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseBody(res) {
  return res && typeof res.json === 'function' ? res.json() : null;
}

export class SemanticScheduler {
  constructor({
    store,
    ledger,
    config = {},
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    onCommit = null,
    onEvent = null,
  } = {}) {
    if (!store || !ledger) throw new Error('store and ledger are required');
    this.store = store;
    this.ledger = ledger;
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 同样避免以 scheduler 为 this 调用宿主 fetch。
    this.fetchImpl = fetchImpl ? (input, init) => fetchImpl(input, init) : null;
    this.now = now;
    // 以箭头函数持有计时器，避免浏览器把 this===scheduler 当成宿主调用而报 Illegal invocation。
    this.setTimeout = (fn, ms) => setTimeoutImpl(fn, ms);
    this.clearTimeout = (id) => clearTimeoutImpl(id);
    this.onCommit = onCommit;
    this.onEvent = onEvent;

    this.running = false;
    this.halted = null;
    this.timer = null;
    this.inFlight = null;
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.retryAvailable = true;
    this.recomputeBudget = this.config.maxRecompute;
    this.staleRecomputes = 0;
    this.sequence = 0;
    this.state = 'idle';
    this.lastStatus = null;
    this.lastReason = null;
    this.lastError = null;
    this.counters = { requests: 0, committed: 0, rejected: 0, retries: 0, degraded: 0, visible: 0 };
    this.events = [];
    this.lastBuilt = null;
    this.unsubscribeLedger = null;
    this.controllers = new Set();
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.unsubscribeLedger = this.ledger.onChange((result) => this.#onLedgerChange(result));
    if (this.ledger.hasPendingInput()) this.notify('start');
    return this;
  }

  stop({ abort = true } = {}) {
    this.running = false;
    this.#clearTimer();
    if (this.unsubscribeLedger) {
      this.unsubscribeLedger();
      this.unsubscribeLedger = null;
    }
    if (abort) {
      if (this.inFlight) this.inFlight.controller.abort();
      for (const controller of this.controllers) controller.abort();
      this.controllers.clear();
    }
    this.#setState('stopped');
    return this;
  }

  /** Called after any accepted transcript change; duplicate input is ignored by the ledger. */
  notify(reason = 'input') {
    if (!this.running) return;
    if (this.halted) return;
    this.dirty = true;
    this.#record('input', { reason, pending: this.ledger.pendingCount() });
    this.#schedule();
  }

  /** After a fixed configuration/state change (e.g. key added) allow work again. */
  resume() {
    this.halted = null;
    this.retryAvailable = true;
    this.recomputeBudget = this.config.maxRecompute;
    this.staleRecomputes = 0;
    this.#setState('idle');
    if (this.ledger.hasPendingInput()) this.notify('resume');
  }

  /** Presenter reports when the committed graph is actually on screen. */
  markVisible(requestId = null) {
    const event = [...this.events].reverse().find((e) => e.kind === 'commit' && (!requestId || e.request_id === requestId));
    if (!event) return null;
    event.first_visible_at = this.now();
    event.visible_ms = event.first_visible_at - event.at;
    this.counters.visible += 1;
    return event.visible_ms;
  }

  #onLedgerChange(result) {
    if (!result || !result.ok || result.applied === false) return;
    for (const inv of result.invalidations || []) {
      this.store.invalidateSource(inv.segment_id, inv.revision, { reason: inv.reason });
    }
    if (result.entry?.phase === 'final') this.staleRecomputes = 0;
    this.notify(result.invalidations?.length ? 'revision' : 'transcript');
  }

  #clearTimer() {
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  #schedule(delay = null) {
    if (!this.running || this.inFlight || this.halted) return;
    if (!this.ledger.hasPendingInput()) {
      this.#setState('idle');
      return;
    }
    const now = this.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    let wait;
    if (delay !== null) wait = Math.max(0, delay);
    else {
      const debounceAt = now + this.config.debounceMs;
      const deadlineAt = this.firstDirtyAt + this.config.maxWaitMs;
      wait = Math.max(0, Math.min(debounceAt, deadlineAt) - now);
    }
    this.#clearTimer();
    this.#setState('scheduled');
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.#startRequest();
    }, wait);
  }

  #buildRequest(built) {
    const view = this.store.graphView();
    const activeId = view.active_scene ? view.active_scene.id : null;
    const nodes = view.nodes.filter((n) => n.scene_id === activeId);
    const edges = view.edges.filter((e) => e.scene_id === activeId);
    this.sequence += 1;
    return {
      schema_version: 1,
      request_id: `${this.config.requestIdPrefix}${this.sequence}`,
      epoch: this.store.epoch,
      base_graph_version: this.store.graphVersion,
      input_version: this.ledger.inputVersion,
      sources: built.sources,
      context: {
        active_scene: view.active_scene,
        nodes,
        edges,
        recent_scenes: this.store.recentScenes(),
        unresolved: view.unresolved,
      },
    };
  }

  #startRequest({ recompute = false } = {}) {
    this.#clearTimer();
    if (!this.running || this.inFlight || this.halted) return null;
    if (this.ledger.epoch !== this.store.epoch) {
      this.#degrade('epoch_mismatch', 'ledger epoch differs from store epoch');
      return null;
    }
    const built = this.ledger.buildSources({ nowMs: this.now() });
    if (!built.sources.length) {
      this.#setState('idle');
      return null;
    }
    this.lastBuilt = built;
    const request = this.#buildRequest(built);
    const began = this.store.beginRequest(request);
    if (!began.ok) {
      this.#record('begin_failed', { request_id: request.request_id, code: began.code });
      this.#setState('error');
      this.lastError = began;
      return null;
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const startedAt = this.now();
    const meta = { request, built, controller, startedAt, recompute, timedOut: false, retried: false };
    meta.promise = this.#perform(meta).then((out) => this.#settle(meta, out));
    this.inFlight = meta;
    this.counters.requests += 1;
    this.#record('request_started', {
      request_id: request.request_id,
      epoch: request.epoch,
      base_graph_version: request.base_graph_version,
      input_version: request.input_version,
      sources: request.sources.map((s) => `${s.segment_id}@${s.revision}`),
      dropped_finals: built.droppedFinals,
      recompute,
    });
    this.#setState('inflight');
    return meta;
  }

  async #perform(meta) {
    const { request, controller, startedAt } = meta;
    const timeout = this.setTimeout(() => {
      meta.timedOut = true;
      controller.abort();
    }, this.config.clientTimeoutMs);
    let out;
    try {
      if (!this.fetchImpl) throw new Error('no fetch implementation');
      const res = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body = await responseBody(res);
      if (!res || res.ok === false || !body) {
        out = {
          response: {
            schema_version: 1,
            request_id: request.request_id,
            epoch: request.epoch,
            base_graph_version: request.base_graph_version,
            input_version: request.input_version,
            status: 'degraded',
            reason: 'upstream_error',
            detail: `http ${res ? res.status : 'unknown'}`,
            considered: [],
            ops: [],
            unresolved: [],
          },
          meta: { latency_ms: this.now() - startedAt },
        };
      } else {
        out = { response: body, meta: body.meta || { latency_ms: this.now() - startedAt } };
      }
    } catch (err) {
      const reason = meta.timedOut ? 'timeout' : controller.signal.aborted ? 'client_abort' : 'upstream_error';
      out = {
        response: {
          schema_version: 1,
          request_id: request.request_id,
          epoch: request.epoch,
          base_graph_version: request.base_graph_version,
          input_version: request.input_version,
          status: 'degraded',
          reason,
          detail: String(err && err.message ? err.message : err),
          considered: [],
          ops: [],
          unresolved: [],
        },
        meta: { latency_ms: this.now() - startedAt },
      };
    } finally {
      this.clearTimeout(timeout);
      this.controllers.delete(controller);
    }
    return out;
  }

  async #settle(meta, out) {
    this.inFlight = null;
    if (!this.running) {
      this.store.abortRequest(meta.request.request_id);
      return;
    }
    const request = meta.request;
    const response = out.response;
    const latency = this.now() - meta.startedAt;

    if (response.epoch !== request.epoch || request.epoch !== this.store.epoch) {
      this.store.abortRequest(request.request_id, { settled: true });
      this.#record('stale_response', { request_id: request.request_id, epoch: response.epoch });
      this.#afterSettle();
      return;
    }

    this.lastStatus = response.status;
    this.lastReason = response.reason || null;

    if (response.status === 'degraded') {
      const result = this.store.commit(response, request);
      this.counters.degraded += 1;
      this.#record('degraded', {
        request_id: request.request_id,
        reason: response.reason,
        detail: response.detail,
        latency_ms: latency,
        request_meta: out.meta,
      });
      if (TRANSIENT.has(response.reason) && this.config.retryTransient && this.retryAvailable && !meta.retried) {
        this.retryAvailable = false;
        this.counters.retries += 1;
        this.#record('retry', { request_id: request.request_id, reason: response.reason });
        this.inFlight = null;
        this.#clearTimer();
        this.timer = this.setTimeout(() => {
          this.timer = null;
          this.#startRequest();
        }, this.config.retryDelayMs);
        this.#setState('retrying');
        return;
      }
      if (response.reason === 'no_key') this.halted = 'no_key';
      else if (TRANSIENT.has(response.reason)) this.halted = `degraded:${response.reason}`;
      this.#degrade(response.reason, response.detail || `request ${request.request_id}`);
      return;
    }

    const result = this.store.commit(response, request);
    if (!result.ok) {
      this.store.abortRequest(request.request_id);
      this.counters.rejected += 1;
      const detail = Array.isArray(result.detail)
        ? result.detail.join('; ')
        : result.detail || (result.errors || []).join('; ');
      this.#record('rejected', { request_id: request.request_id, code: result.code, detail, latency_ms: latency });
      if (result.code === 'source_changed') {
        // 讲话中的 partial 会不断改写来源。旧响应必须作废，但这不是“坏批”，
        // 更不能让连续讲话永久停摆：退避后用最新状态重算，pending 一直保留。
        this.staleRecomputes += 1;
        const over = this.staleRecomputes - this.config.maxRecompute;
        const delay = over > 0 ? Math.min(1500, this.config.recomputeBackoffMs * over) : this.config.retryDelayMs;
        this.#setState('recomputing');
        this.#clearTimer();
        this.timer = this.setTimeout(() => {
          this.timer = null;
          this.#startRequest({ recompute: true });
        }, delay);
        return;
      }
      if (result.code === 'version_conflict') {
        this.recomputeBudget -= 1;
        if (this.recomputeBudget > 0) {
          this.#setState('recomputing');
          this.#clearTimer();
          this.timer = this.setTimeout(() => {
            this.timer = null;
            this.#startRequest({ recompute: true });
          }, this.config.retryDelayMs);
          return;
        }
        this.#degrade('conflict', `${result.code}: ${(result.detail || []).join(', ')}`);
        return;
      }
      this.#degrade('invalid_batch', `${result.code}: ${(result.detail || []).join(', ')}`);
      return;
    }

    this.retryAvailable = true;
    this.recomputeBudget = this.config.maxRecompute;
    this.staleRecomputes = 0;
    this.counters.committed += 1;
    const consumed = this.ledger.markConsumed(response.considered || []);
    if (consumed) this.#record('consumed', { considered: (response.considered || []).length });
    const applied = result.applied === true;
    const event = this.#record('commit', {
      request_id: request.request_id,
      status: response.status,
      applied,
      ops: (response.ops || []).length,
      graph_version: result.state.graph_version,
      latency_ms: latency,
      considered: (response.considered || []).map((c) => `${c.segment_id}@${c.revision}`),
    });
    this.#setState(applied ? 'committed' : 'held');
    if (typeof this.onCommit === 'function') {
      try {
        this.onCommit(result.state, {
          request,
          response,
          result,
          scheduler: this,
          markVisible: () => this.markVisible(request.request_id),
          metrics: event,
        });
      } catch (err) {
        this.#record('presenter_error', { message: String(err && err.message ? err.message : err) });
      }
    }
    this.#afterSettle();
  }

  #afterSettle() {
    if (!this.running || this.halted) return;
    if (this.ledger.hasPendingInput()) {
      this.dirty = false;
      this.firstDirtyAt = 0;
      this.#schedule(0);
    } else {
      this.dirty = false;
      this.firstDirtyAt = 0;
      this.#setState('idle');
    }
  }

  #degrade(reason, detail) {
    this.lastStatus = 'degraded';
    this.lastReason = reason;
    this.#record('halt', { reason, detail });
    this.#setState('degraded');
  }

  #setState(state) {
    this.state = state;
  }

  #record(kind, data = {}) {
    const event = { kind, at: this.now(), ...data };
    this.events.push(event);
    if (this.events.length > this.config.maxEvents) this.events.splice(0, this.events.length - this.config.maxEvents);
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(event);
      } catch {
        /* diagnostics must never break the pipeline */
      }
    }
    return event;
  }

  /** Tests and demos: run until pending input is consumed or no progress is possible. */
  async flush({ maxRounds = 20 } = {}) {
    this.#clearTimer();
    for (let round = 0; round < maxRounds; round++) {
      if (!this.running || this.halted) break;
      if (this.inFlight) {
        await this.inFlight.promise;
        continue;
      }
      if (this.state === 'retrying' || this.state === 'recomputing') {
        await sleep(this.config.retryDelayMs + 5);
        continue;
      }
      if (!this.ledger.hasPendingInput()) break;
      const meta = this.#startRequest();
      if (!meta) break;
      await meta.promise;
    }
    this.#clearTimer();
    return this.diagnostics;
  }

  /** Await the current request plus its immediate follow-up. */
  async idle() {
    while (this.inFlight) {
      await this.inFlight.promise;
      if (this.timer !== null) {
        this.#clearTimer();
        if (this.ledger.hasPendingInput() && !this.halted) {
          const meta = this.#startRequest();
          if (meta) await meta.promise;
        }
      }
    }
    return this;
  }

  get diagnostics() {
    const built = this.lastBuilt;
    return {
      state: this.state,
      halted: this.halted,
      in_flight: Boolean(this.inFlight),
      pending: this.ledger.pendingCount(),
      oldest_pending_ms: this.ledger.oldestPendingAgeMs(this.now()),
      last_status: this.lastStatus,
      last_reason: this.lastReason,
      last_error: this.lastError,
      counters: { ...this.counters },
      backlog: built
        ? {
            finals: built.backlog.finals,
            dropped: built.backlog.dropped,
            chars: built.chars,
            age_ms: built.backlog.ageMs,
          }
        : null,
      events: this.events.slice(-30),
    };
  }
}

/** Convenience for tests: wait until predicate or timeout. */
export async function waitFor(predicate, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

export { DEFAULT_CONFIG };
