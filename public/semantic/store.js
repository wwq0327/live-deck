// 语义图 Store：可修正的 Scene/Node/Edge、证据、版本与原子提交。
// 纯 ESM，无 DOM 依赖；浏览器与 Node 测试共用。
import {
  ACYCLIC_RELATIONS,
  CLAIM_KINDS,
  FAMILIES,
  LIMITS,
  OBJECT_STATES,
  RELATIONS,
  SCHEMA_VERSION,
  checkOps,
  checkUnderstandResponse,
  idOwnedBy,
  isInt,
  isObject,
  isText,
  oneOf,
  parseId,
} from './protocol.js';

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

const fail = (code, errors) => ({ ok: false, committed: false, code, errors: [].concat(errors) });

function createState(epoch) {
  return {
    schema_version: SCHEMA_VERSION,
    epoch,
    graph_version: 0,
    active_scene_id: null,
    scenes: {},
    nodes: {},
    edges: {},
    receipts: {},
    unresolved: [],
    history: [],
  };
}

function sceneOf(state, id) {
  return state.scenes[id] || null;
}

function nodeOf(state, id) {
  return state.nodes[id] || null;
}

function edgeOf(state, id) {
  return state.edges[id] || null;
}

function linkScene(state, sceneId, kind, id) {
  const scene = state.scenes[sceneId];
  if (!scene) return;
  const key = kind === 'node' ? 'node_ids' : 'edge_ids';
  if (!scene[key].includes(id)) scene[key].push(id);
}

function unlinkScene(state, sceneId, kind, id) {
  const scene = state.scenes[sceneId];
  if (!scene) return;
  const key = kind === 'node' ? 'node_ids' : 'edge_ids';
  scene[key] = scene[key].filter((x) => x !== id);
}

function retractEdge(state, id, reason) {
  const edge = state.edges[id];
  if (!edge || edge.state === 'retracted') return false;
  edge.state = 'retracted';
  edge.retracted_reason = reason || '';
  edge.retracted_at = state.graph_version + 1;
  return true;
}

function retractNode(state, id, reason) {
  const node = state.nodes[id];
  if (!node || node.state === 'retracted') return [];
  node.state = 'retracted';
  node.retracted_reason = reason || '';
  const touched = [id];
  for (const edge of Object.values(state.edges)) {
    if (edge.state === 'retracted') continue;
    if (edge.from === id || edge.to === id) {
      if (retractEdge(state, edge.id, `node ${id} retracted`)) touched.push(edge.id);
    }
  }
  return touched;
}

/** 第一版：因果与组成禁止环。返回环上的节点路径或 null。 */
function findCycle(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (e.state === 'retracted' || !ACYCLIC_RELATIONS.includes(e.relation)) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const color = new Map();
  const path = [];
  const visit = (id) => {
    const state = color.get(id) || 0;
    if (state === 2) return null;
    if (state === 1) {
      const at = path.lastIndexOf(id);
      return path.slice(at === -1 ? 0 : at).concat(id);
    }
    color.set(id, 1);
    path.push(id);
    for (const next of adj.get(id) || []) {
      const hit = visit(next);
      if (hit) return hit;
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of adj.keys()) {
    const hit = visit(id);
    if (hit) return hit;
  }
  return null;
}

function evidenceKeys(list) {
  return (list || []).map((e) => `${e.segment_id}@${e.revision}`);
}

function mergeEvidence(oldList, newList) {
  const seen = new Set();
  const out = [];
  for (const e of [...(oldList || []), ...(newList || [])]) {
    const key = `${e.segment_id}@${e.revision}#${e.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ segment_id: e.segment_id, revision: e.revision, quote: e.quote });
    if (out.length >= LIMITS.maxEvidence) break;
  }
  return out;
}

export class SemanticStore {
  constructor({ epoch = 1, ledger = null } = {}) {
    this.state = createState(epoch);
    this.ledger = ledger;
    this.requests = new Map();
    this.settled = new Map();
    this.listeners = new Set();
  }

  get epoch() {
    return this.state.epoch;
  }

  get graphVersion() {
    return this.state.graph_version;
  }

  snapshot() {
    return clone(this.state);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(reason) {
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot(), reason);
      } catch {
        /* 观察者异常不能中断提交 */
      }
    }
  }

  reset({ epoch = this.state.epoch + 1 } = {}) {
    this.state = createState(epoch);
    this.requests.clear();
    this.settled.clear();
    this.#emit('reset');
  }

  /** 记录一个在途请求；重复 request_id 属于调用方错误。 */
  beginRequest(request) {
    if (!isObject(request) || !isText(request.request_id, 64)) return fail('invalid_request', 'request_id invalid');
    if (request.epoch !== this.state.epoch) return fail('epoch_mismatch', 'request epoch is not current');
    if (this.requests.has(request.request_id) || this.settled.has(request.request_id)) {
      return fail('duplicate_request', `request ${request.request_id} already exists`);
    }
    this.requests.set(request.request_id, {
      epoch: request.epoch,
      base_graph_version: request.base_graph_version,
      input_version: request.input_version,
      sources: (request.sources || []).map((s) => `${s.segment_id}@${s.revision}`),
      started_at: Date.now(),
    });
    return { ok: true };
  }

  abortRequest(requestId, { settled = false } = {}) {
    this.requests.delete(requestId);
    if (settled) this.settled.set(requestId, { aborted: true, at: Date.now() });
  }

  inflightCount() {
    return this.requests.size;
  }

  currentRevision(segmentId) {
    if (!this.ledger) return null;
    const cur = this.ledger.current(segmentId);
    return cur ? cur.revision : null;
  }

  /** 证据必须能在账本里逐字找到；并且是本次请求提供过、或图中已有的来源。 */
  #verifyEvidence(evidence, request, state) {
    const errors = [];
    const allowed = new Set((request.sources || []).map((s) => `${s.segment_id}@${s.revision}`));
    for (const item of Object.values(state.nodes)) {
      for (const key of evidenceKeys(item.evidence)) allowed.add(key);
    }
    for (const item of Object.values(state.edges)) {
      for (const key of evidenceKeys(item.evidence)) allowed.add(key);
    }
    for (const e of evidence || []) {
      const key = `${e.segment_id}@${e.revision}`;
      const found = this.ledger ? this.ledger.getRevision(e.segment_id, e.revision) : null;
      if (!found) {
        errors.push(`evidence ${key}: revision not in transcript ledger`);
        continue;
      }
      if (!allowed.has(key)) {
        errors.push(`evidence ${key}: not provided in request sources`);
        continue;
      }
      if (!found.text.includes(e.quote)) {
        errors.push(`evidence ${key}: quote not found verbatim`);
      }
    }
    return errors;
  }

  #applyOps(ops, request, state) {
    const errors = [];
    const requestId = request.request_id;
    const extra = [];
    const createdScenes = [];
    let explicitActive = false;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const at = `ops[${i}].${op.op}`;
      if (op.op === 'create_scene') {
        const scene = clone(op.scene);
        if (state.scenes[scene.id]) {
          errors.push(`${at}: scene ${scene.id} already exists`);
          continue;
        }
        if (!idOwnedBy(scene.id, requestId, 'scene')) {
          errors.push(`${at}: scene id not in request namespace`);
          continue;
        }
        state.scenes[scene.id] = {
          id: scene.id,
          title: scene.title,
          family: scene.family,
          node_ids: [],
          edge_ids: [],
          focus_ids: [],
          status: 'archived',
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        createdScenes.push(scene.id);
        continue;
      }

      if (op.op === 'update_scene') {
        const target = sceneOf(state, op.scene?.id);
        if (!target) {
          errors.push(`${at}: scene not found`);
          continue;
        }
        if (op.scene.title !== undefined) target.title = op.scene.title;
        if (op.scene.family !== undefined) target.family = op.scene.family;
        target.updated_at = Date.now();
        continue;
      }

      if (op.op === 'upsert_node') {
        const raw = clone(op.node);
        const existing = nodeOf(state, raw.id);
        if (existing) {
          if (existing.state === 'retracted') {
            errors.push(`${at}: node ${raw.id} is retracted; use a new id`);
            continue;
          }
          if (raw.scene_id !== existing.scene_id) {
            errors.push(`${at}: node ${raw.id} cannot move between scenes`);
            continue;
          }
          existing.label = raw.label;
          existing.role = raw.role || existing.role || 'concept';
          existing.claim_kind = raw.claim_kind;
          existing.speaker_id = raw.speaker_id || existing.speaker_id || 'unknown';
          existing.state = raw.state && raw.state !== 'retracted' ? raw.state : existing.state || 'supported';
          existing.evidence = mergeEvidence(existing.evidence, raw.evidence);
          existing.updated_at = Date.now();
          extra.push(...this.#verifyEvidence(raw.evidence, request, state).map((e) => `${at}: ${e}`));
          continue;
        }
        if (!idOwnedBy(raw.id, requestId, 'node')) {
          errors.push(`${at}: node id not in request namespace or already used`);
          continue;
        }
        if (!state.scenes[raw.scene_id]) {
          errors.push(`${at}: scene ${raw.scene_id} not found`);
          continue;
        }
        const evErrors = this.#verifyEvidence(raw.evidence, request, state);
        if (evErrors.length) {
          errors.push(...evErrors.map((e) => `${at}: ${e}`));
          continue;
        }
        state.nodes[raw.id] = {
          id: raw.id,
          scene_id: raw.scene_id,
          label: raw.label,
          role: raw.role || 'concept',
          claim_kind: raw.claim_kind,
          speaker_id: raw.speaker_id || 'unknown',
          evidence: mergeEvidence([], raw.evidence),
          state: raw.state && raw.state !== 'retracted' ? raw.state : 'supported',
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        linkScene(state, raw.scene_id, 'node', raw.id);
        continue;
      }

      if (op.op === 'upsert_edge') {
        const raw = clone(op.edge);
        const existing = edgeOf(state, raw.id);
        if (existing) {
          if (existing.state === 'retracted') {
            errors.push(`${at}: edge ${raw.id} is retracted; use a new id`);
            continue;
          }
          if (!nodeOf(state, raw.from) || !nodeOf(state, raw.to)) {
            errors.push(`${at}: edge endpoints missing`);
            continue;
          }
          if (nodeOf(state, raw.from).scene_id !== raw.scene_id || nodeOf(state, raw.to).scene_id !== raw.scene_id) {
            errors.push(`${at}: edge endpoints must belong to ${raw.scene_id}`);
            continue;
          }
          existing.from = raw.from;
          existing.to = raw.to;
          existing.relation = raw.relation;
          existing.label = raw.label || '';
          existing.claim_kind = raw.claim_kind;
          existing.speaker_id = raw.speaker_id || existing.speaker_id || 'unknown';
          existing.evidence = mergeEvidence(existing.evidence, raw.evidence);
          existing.updated_at = Date.now();
          extra.push(...this.#verifyEvidence(raw.evidence, request, state).map((e) => `${at}: ${e}`));
          continue;
        }
        if (!idOwnedBy(raw.id, requestId, 'edge')) {
          errors.push(`${at}: edge id not in request namespace or already used`);
          continue;
        }
        if (!state.scenes[raw.scene_id]) {
          errors.push(`${at}: scene ${raw.scene_id} not found`);
          continue;
        }
        const from = nodeOf(state, raw.from);
        const to = nodeOf(state, raw.to);
        if (!from || !to) {
          errors.push(`${at}: edge endpoints missing`);
          continue;
        }
        if (from.scene_id !== raw.scene_id || to.scene_id !== raw.scene_id) {
          errors.push(`${at}: edge endpoints must belong to ${raw.scene_id}`);
          continue;
        }
        if (from.state === 'retracted' || to.state === 'retracted') {
          errors.push(`${at}: edge endpoints retracted`);
          continue;
        }
        const evErrors = this.#verifyEvidence(raw.evidence, request, state);
        if (evErrors.length) {
          errors.push(...evErrors.map((e) => `${at}: ${e}`));
          continue;
        }
        state.edges[raw.id] = {
          id: raw.id,
          scene_id: raw.scene_id,
          from: raw.from,
          to: raw.to,
          relation: raw.relation,
          label: raw.label || '',
          claim_kind: raw.claim_kind,
          speaker_id: raw.speaker_id || 'unknown',
          evidence: mergeEvidence([], raw.evidence),
          state: raw.state && raw.state !== 'retracted' ? raw.state : 'supported',
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        linkScene(state, raw.scene_id, 'edge', raw.id);
        continue;
      }

      if (op.op === 'retract') {
        const node = nodeOf(state, op.id);
        const edge = edgeOf(state, op.id);
        if (!node && !edge) {
          errors.push(`${at}: ${op.id} not found`);
          continue;
        }
        if (node) retractNode(state, op.id, op.reason);
        else retractEdge(state, op.id, op.reason);
        continue;
      }

      if (op.op === 'focus') {
        const scene = sceneOf(state, op.scene_id);
        if (!scene) {
          errors.push(`${at}: scene not found`);
          continue;
        }
        const bad = op.ids.filter((id) => {
          const n = nodeOf(state, id);
          return !n || n.scene_id !== op.scene_id || n.state === 'retracted';
        });
        if (bad.length) {
          errors.push(`${at}: unknown nodes ${bad.join(',')}`);
          continue;
        }
        scene.focus_ids = [...new Set(op.ids)];
        scene.updated_at = Date.now();
        this.#setActive(state, op.scene_id);
        explicitActive = true;
        continue;
      }

      if (op.op === 'activate_scene') {
        const scene = sceneOf(state, op.scene_id);
        if (!scene) {
          errors.push(`${at}: scene not found`);
          continue;
        }
        this.#setActive(state, op.scene_id);
        explicitActive = true;
        continue;
      }
    }

    // 新场景默认成为当前场景（模型显式 activate/focus 时以它为准）；
    // status 只由 active_scene_id 派生，避免出现多个 active。
    if (!explicitActive && createdScenes.length) this.#setActive(state, createdScenes[createdScenes.length - 1]);
    for (const scene of Object.values(state.scenes)) {
      scene.status = scene.id === state.active_scene_id ? 'active' : 'archived';
    }

    errors.push(...extra);

    // 整批应用后统一检查端点、归属与环。
    for (const edge of Object.values(state.edges)) {
      if (edge.state === 'retracted') continue;
      const from = state.nodes[edge.from];
      const to = state.nodes[edge.to];
      if (!from || !to) errors.push(`edge ${edge.id}: endpoint missing after batch`);
      else if (from.scene_id !== edge.scene_id || !state.scenes[edge.scene_id]) {
        errors.push(`edge ${edge.id}: scene mismatch after batch`);
      }
    }
    const cycle = findCycle(Object.values(state.edges));
    if (cycle) errors.push(`cycle rejected: ${cycle.join(' -> ')}`);
    return errors;
  }

  #setActive(state, sceneId) {
    if (state.active_scene_id === sceneId) return;
    const prev = state.scenes[state.active_scene_id];
    if (prev && prev.status === 'active') prev.status = 'archived';
    state.active_scene_id = sceneId;
    const next = state.scenes[sceneId];
    if (next) next.status = 'active';
  }

  /**
   * 提交一包模型操作。全部校验通过才替换状态；失败时图、receipts 都不变。
   * 返回 { ok, committed, duplicate, code, errors, state }。
   */
  commit(response, request, { ledger = this.ledger } = {}) {
    const shapeErrors = checkUnderstandResponse(response, request);
    if (shapeErrors.length) return fail('invalid_response', shapeErrors);

    const inflight = this.requests.get(request.request_id);
    const settled = this.settled.get(request.request_id);
    if (!inflight) {
      if (settled) return { ok: true, committed: false, duplicate: true, state: this.snapshot() };
      return fail('unknown_request', `request ${request.request_id} is not in flight`);
    }
    if (response.epoch !== this.state.epoch || request.epoch !== this.state.epoch) {
      return fail('epoch_mismatch', 'response epoch is not current');
    }

    if (response.status === 'degraded') {
      this.requests.delete(request.request_id);
      return {
        ok: true,
        committed: false,
        degraded: true,
        reason: response.reason || 'upstream_error',
        state: this.snapshot(),
      };
    }

    if (response.base_graph_version !== this.state.graph_version) {
      return fail('version_conflict', `base_graph_version ${response.base_graph_version} != ${this.state.graph_version}`);
    }

    // 依赖的 source revision 必须仍是当前账本版本；单纯新增输入不影响。
    // 例外：ASR partial 只是向后延长（旧文本是新文本前缀）时，旧判断仍成立，
    // 允许提交并把 receipt 记到新 revision，避免连续讲话时永远被 source_changed 饿死。
    // final 覆盖不适用（final 的尾部可能带来新信息），仍然要求重算。
    const upgraded = new Map();
    const quotesBySegment = new Map();
    const collectEvidence = (value) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(collectEvidence);
        return;
      }
      if (value.segment_id && typeof value.quote === 'string') {
        if (!quotesBySegment.has(value.segment_id)) quotesBySegment.set(value.segment_id, []);
        quotesBySegment.get(value.segment_id).push(value.quote);
        return;
      }
      Object.values(value).forEach(collectEvidence);
    };
    collectEvidence([response.ops || [], response.unresolved || []]);
    if (ledger) {
      const changed = [];
      for (const s of request.sources || []) {
        const cur = ledger.current(s.segment_id);
        if (!cur) {
          changed.push(`${s.segment_id}@${s.revision}`);
          continue;
        }
        if (cur.revision === s.revision) {
          if (cur.text !== s.text) changed.push(`${s.segment_id}@${s.revision}#text`);
          continue;
        }
        const sameText = cur.revision > s.revision && cur.text.trim() === s.text.trim();
        const grewPartial =
          cur.phase === 'partial' && cur.revision > s.revision && cur.text.trim().startsWith(s.text.trim());
        // ASR 会在同一 partial 段里改写个别词。只要本次引用的证据仍然逐字存在，
        // 该批判断就仍然有据；否则视为语义纠正，要求重算。
        const quotes = quotesBySegment.get(s.segment_id) || [];
        const quotesSurvive =
          cur.phase === 'partial' && cur.revision > s.revision && quotes.length > 0 && quotes.every((q) => cur.text.includes(q));
        if (sameText || grewPartial || quotesSurvive) upgraded.set(s.segment_id, cur.revision);
        else changed.push(`${s.segment_id}@${s.revision}`);
      }
      if (changed.length) return fail('source_changed', changed);
    }

    const opErrors = checkOps(response.ops || [], request.request_id);
    if (opErrors.length) return fail('invalid_ops', opErrors);

    const next = clone(this.state);
    const applyErrors = this.#applyOps(response.ops || [], request, next);
    if (applyErrors.length) return fail('invalid_ops', applyErrors);

    const considered = response.considered || [];
    const applied = (response.ops || []).length > 0;
    if (applied) next.graph_version = this.state.graph_version + 1;
    next.unresolved = clone(response.unresolved || []).map((u) => ({
      text: u.text,
      evidence: u.evidence || [],
      at: Date.now(),
    }));
    const consumed = [];
    for (const c of considered) {
      const revision = upgraded.get(c.segment_id) || c.revision;
      next.receipts[c.segment_id] = revision;
      consumed.push({ segment_id: c.segment_id, revision });
    }
    next.history.push({
      at: Date.now(),
      request_id: request.request_id,
      graph_version: next.graph_version,
      base_graph_version: request.base_graph_version,
      status: response.status,
      op_count: (response.ops || []).length,
      considered: considered.map((c) => `${c.segment_id}@${c.revision}`),
      ops: (response.ops || []).map((op) => op.op),
    });
    if (next.history.length > 200) next.history = next.history.slice(-200);

    this.state = next;
    this.requests.delete(request.request_id);
    this.settled.set(request.request_id, { at: Date.now(), graph_version: next.graph_version });
    this.#emit('commit');
    return {
      ok: true,
      committed: true,
      applied: applied,
      status: response.status,
      consumed,
      state: this.snapshot(),
    };
  }

  /**
   * 人工纠正是独立通道：只允许改已有对象、撤回、聚焦、回看。
   * 不经过模型请求，也不需要新的证据；保留原证据与历史。
   */
  applyManual(ops, { requestId = 'manual' } = {}) {
    if (!Array.isArray(ops) || !ops.length) return fail('invalid_ops', 'ops empty');
    const errors = [];
    const next = clone(this.state);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const at = `manual[${i}].${op?.op}`;
      if (!isObject(op)) {
        errors.push(`${at}: not an object`);
        continue;
      }
      if (op.op === 'upsert_node') {
        const node = nodeOf(next, op.node?.id);
        if (!node) errors.push(`${at}: manual correction cannot create nodes`);
        else if (node.state === 'retracted') errors.push(`${at}: node retracted`);
        else {
          if (!isText(op.node.label, LIMITS.maxLabel)) errors.push(`${at}: label invalid`);
          if (op.node.claim_kind !== undefined && !oneOf(op.node.claim_kind, CLAIM_KINDS)) {
            errors.push(`${at}: claim_kind invalid`);
          }
          if (op.node.relation !== undefined) errors.push(`${at}: nodes have no relation`);
          if (!errors.length) {
            if (op.node.label) node.label = op.node.label;
            if (op.node.claim_kind) node.claim_kind = op.node.claim_kind;
            node.manual = true;
            node.updated_at = Date.now();
          }
        }
        continue;
      }
      if (op.op === 'upsert_edge') {
        const edge = edgeOf(next, op.edge?.id);
        if (!edge) errors.push(`${at}: manual correction cannot create edges`);
        else if (edge.state === 'retracted') errors.push(`${at}: edge retracted`);
        else {
          if (op.edge.from !== undefined && !nodeOf(next, op.edge.from)) errors.push(`${at}: from missing`);
          if (op.edge.to !== undefined && !nodeOf(next, op.edge.to)) errors.push(`${at}: to missing`);
          if (op.edge.relation !== undefined && !oneOf(op.edge.relation, RELATIONS)) errors.push(`${at}: relation invalid`);
          if (op.edge.label !== undefined && !isText(op.edge.label, LIMITS.maxLabel, { allowEmpty: true })) {
            errors.push(`${at}: label invalid`);
          }
          if (!errors.length) {
            if (op.edge.from) edge.from = op.edge.from;
            if (op.edge.to) edge.to = op.edge.to;
            if (op.edge.relation) edge.relation = op.edge.relation;
            if (op.edge.label !== undefined) edge.label = op.edge.label;
            edge.manual = true;
            edge.updated_at = Date.now();
          }
        }
        continue;
      }
      if (op.op === 'retract') {
        if (!nodeOf(next, op.id) && !edgeOf(next, op.id)) errors.push(`${at}: ${op.id} not found`);
        else if (nodeOf(next, op.id)) retractNode(next, op.id, op.reason || 'manual');
        else retractEdge(next, op.id, op.reason || 'manual');
        continue;
      }
      if (op.op === 'focus') {
        const scene = sceneOf(next, op.scene_id);
        if (!scene) errors.push(`${at}: scene not found`);
        else if (!Array.isArray(op.ids) || op.ids.some((id) => !nodeOf(next, id))) errors.push(`${at}: unknown node`);
        else {
          scene.focus_ids = [...new Set(op.ids)];
          this.#setActive(next, op.scene_id);
        }
        continue;
      }
      if (op.op === 'activate_scene') {
        if (!sceneOf(next, op.scene_id)) errors.push(`${at}: scene not found`);
        else this.#setActive(next, op.scene_id);
        continue;
      }
      if (op.op === 'update_scene') {
        const scene = sceneOf(next, op.scene?.id);
        if (!scene) errors.push(`${at}: scene not found`);
        else {
          if (op.scene.title !== undefined) {
            if (!isText(op.scene.title, LIMITS.maxTitle)) errors.push(`${at}: title invalid`);
            else scene.title = op.scene.title;
          }
          if (op.scene.family !== undefined) {
            if (!oneOf(op.scene.family, FAMILIES)) errors.push(`${at}: family invalid`);
            else scene.family = op.scene.family;
          }
          scene.manual = true;
        }
        continue;
      }
      errors.push(`${at}: unsupported manual op`);
    }
    if (errors.length) return fail('manual_rejected', errors);
    const cycle = findCycle(Object.values(next.edges));
    if (cycle) return fail('manual_rejected', `cycle rejected: ${cycle.join(' -> ')}`);
    next.graph_version = this.state.graph_version + 1;
    next.history.push({
      at: Date.now(),
      request_id: requestId,
      graph_version: next.graph_version,
      status: 'manual',
      op_count: ops.length,
      considered: [],
      ops: ops.map((op) => op.op),
    });
    this.state = next;
    this.#emit('manual');
    return { ok: true, committed: true, state: this.snapshot() };
  }

  /** 来源 revision 被替换：引用它的对象标 stale，版本递增，等待重算。 */
  invalidateSource(segmentId, revision, { reason = 'source replaced' } = {}) {
    const next = clone(this.state);
    const affected = [];
    for (const obj of [...Object.values(next.nodes), ...Object.values(next.edges)]) {
      if (obj.state === 'retracted' || obj.state === 'stale') continue;
      const hit = (obj.evidence || []).some((e) => e.segment_id === segmentId && e.revision === revision);
      if (!hit) continue;
      obj.state = 'stale';
      obj.stale_reason = reason;
      affected.push(obj.id);
    }
    if (!affected.length) return { ok: true, changed: false, affected: [] };
    next.graph_version = this.state.graph_version + 1;
    next.history.push({
      at: Date.now(),
      request_id: 'invalidate',
      graph_version: next.graph_version,
      status: 'stale',
      op_count: affected.length,
      considered: [`${segmentId}@${revision}`],
      ops: ['invalidate_source'],
    });
    this.state = next;
    this.#emit('stale');
    return { ok: true, changed: true, affected };
  }

  /** 当前可见场景：显式激活优先，否则最新活跃场景。 */
  activeScene() {
    const id = this.state.active_scene_id;
    if (id && this.state.scenes[id]) return this.state.scenes[id];
    const scenes = Object.values(this.state.scenes);
    return scenes.length ? scenes[scenes.length - 1] : null;
  }

  sceneGraph(sceneId = null) {
    const scene = sceneId ? this.state.scenes[sceneId] : this.activeScene();
    if (!scene) return { scene: null, nodes: [], edges: [] };
    const nodes = scene.node_ids.map((id) => this.state.nodes[id]).filter(Boolean);
    const edges = scene.edge_ids.map((id) => this.state.edges[id]).filter(Boolean);
    return { scene: clone(scene), nodes: clone(nodes), edges: clone(edges) };
  }

  recentScenes(limit = LIMITS.maxRecentScenes) {
    const ids = Object.keys(this.state.scenes);
    return ids
      .filter((id) => id !== this.state.active_scene_id)
      .slice(-limit)
      .map((id) => {
        const scene = this.state.scenes[id];
        return {
          id: scene.id,
          title: scene.title,
          family: scene.family,
          status: scene.status,
          nodes: scene.node_ids.map((nid) => this.state.nodes[nid]?.label).filter(Boolean).slice(0, 8),
        };
      });
  }

  graphView() {
    return {
      active_scene: this.activeScene()
        ? {
            id: this.activeScene().id,
            title: this.activeScene().title,
            family: this.activeScene().family,
          }
        : null,
      nodes: Object.values(this.state.nodes).map((n) => ({
        id: n.id,
        scene_id: n.scene_id,
        label: n.label,
        claim_kind: n.claim_kind,
        state: n.state,
        manual: Boolean(n.manual),
      })),
      edges: Object.values(this.state.edges).map((e) => ({
        id: e.id,
        scene_id: e.scene_id,
        from: e.from,
        to: e.to,
        relation: e.relation,
        label: e.label,
        claim_kind: e.claim_kind,
        state: e.state,
        manual: Boolean(e.manual),
      })),
      unresolved: clone(this.state.unresolved),
    };
  }
}

export { createState, findCycle };
