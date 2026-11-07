// 语义协议 v1：常量、边界与结构校验。
// 浏览器（public/semantic/*）与 Node（server、测试）共用，纯函数、无依赖。
// 字段定义见 docs/plans/2026-11-07-continuous-visual-thinking/protocol.md。

export const SCHEMA_VERSION = 1;

export const FAMILIES = ['cause', 'compare', 'composition', 'convergence', 'text'];
export const RELATIONS = ['causes', 'contrasts', 'part_of', 'converges_to', 'sequence', 'conditional'];
export const CLAIM_KINDS = ['assertion', 'hypothesis', 'question', 'proposal', 'quotation'];
export const OBJECT_STATES = ['tentative', 'supported', 'stale', 'retracted'];
export const RESPONSE_STATUS = ['ok', 'hold', 'degraded'];
export const PHASES = ['partial', 'final'];
export const OP_TYPES = [
  'create_scene',
  'update_scene',
  'upsert_node',
  'upsert_edge',
  'retract',
  'focus',
  'activate_scene',
];
export const DEGRADE_REASONS = ['no_key', 'timeout', 'invalid_output', 'upstream_error', 'client_abort'];

// 有向关系：第一版禁止自成环与环状图（反馈环另行设计）。
export const DIRECTED_RELATIONS = ['causes', 'part_of', 'converges_to', 'sequence', 'conditional'];
// 只允许单向、且必须无环的两类关系（因果、组成）。
export const ACYCLIC_RELATIONS = ['causes', 'part_of'];

export const LIMITS = {
  maxOps: 12,
  maxLabel: 28,
  maxTitle: 32,
  maxQuote: 160,
  maxSpeaker: 64,
  maxSources: 24,
  maxSourceChars: 6000,
  maxEvidence: 8,
  maxNodesPerScene: 6,
  maxEdgesPerScene: 8,
  maxRecentScenes: 4,
  maxUnresolved: 12,
  contextWindowMs: 120_000,
  contextWindowChars: 3000,
  maxBodyBytes: 512 * 1024,
};

export function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function isInt(v, min = 0) {
  return Number.isInteger(v) && v >= min;
}

export function isText(v, max, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!allowEmpty && !s) return false;
  return s.length <= max;
}

export function oneOf(v, list) {
  return list.includes(v);
}

/** 协议里的宿主命名空间 ID：s_<requestId>_<序号> */
export function makeId(kind, requestId, seq) {
  const prefix = kind === 'scene' ? 's' : kind === 'node' ? 'n' : 'e';
  return `${prefix}_${requestId}_${seq}`;
}

export function parseId(id) {
  if (typeof id !== 'string') return null;
  const m = /^([sne])_([A-Za-z0-9][A-Za-z0-9_-]*)_(\d{1,6})$/.exec(id);
  if (!m) return null;
  return { kind: m[1] === 's' ? 'scene' : m[1] === 'n' ? 'node' : 'edge', requestId: m[2], seq: Number(m[3]) };
}

function prefixFor(kind) {
  return kind === 'scene' ? 's' : kind === 'node' ? 'n' : 'e';
}

/** 新 ID 必须属于本请求命名空间；模型不得伪造别人的命名空间。 */
export function idOwnedBy(id, requestId, kind) {
  const p = parseId(id);
  return Boolean(p) && p.kind === kind && p.requestId === requestId && prefixFor(kind) === id.slice(0, 1);
}

export function checkEvidence(evidence, { max = LIMITS.maxEvidence } = {}) {
  const errors = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push('evidence must be a non-empty array');
    return errors;
  }
  if (evidence.length > max) errors.push(`evidence exceeds ${max}`);
  evidence.forEach((e, i) => {
    if (!isObject(e)) {
      errors.push(`evidence[${i}] must be an object`);
      return;
    }
    if (!isText(e.segment_id, 64)) errors.push(`evidence[${i}].segment_id invalid`);
    if (!isInt(e.revision, 1)) errors.push(`evidence[${i}].revision invalid`);
    if (!isText(e.quote, LIMITS.maxQuote)) errors.push(`evidence[${i}].quote invalid`);
  });
  return errors;
}

export function checkSourceList(sources) {
  const errors = [];
  if (!Array.isArray(sources)) return ['sources must be an array'];
  if (sources.length > LIMITS.maxSources) errors.push(`sources exceeds ${LIMITS.maxSources}`);
  let chars = 0;
  const seen = new Set();
  sources.forEach((s, i) => {
    if (!isObject(s)) {
      errors.push(`sources[${i}] must be an object`);
      return;
    }
    if (!isText(s.segment_id, 64)) errors.push(`sources[${i}].segment_id invalid`);
    if (!isInt(s.revision, 1)) errors.push(`sources[${i}].revision invalid`);
    if (!isInt(s.order, 1)) errors.push(`sources[${i}].order invalid`);
    if (!oneOf(s.phase, PHASES)) errors.push(`sources[${i}].phase invalid`);
    if (typeof s.text !== 'string') errors.push(`sources[${i}].text must be a string`);
    else chars += s.text.length;
    if (s.speaker_id !== undefined && !isText(s.speaker_id, LIMITS.maxSpeaker, { allowEmpty: true })) {
      errors.push(`sources[${i}].speaker_id invalid`);
    }
    const key = `${s.segment_id}@${s.revision}`;
    if (seen.has(key)) errors.push(`sources[${i}] duplicates ${key}`);
    seen.add(key);
  });
  if (chars > LIMITS.maxSourceChars) errors.push(`sources text exceeds ${LIMITS.maxSourceChars} chars`);
  return errors;
}

export function checkUnderstandRequest(request) {
  const errors = [];
  if (!isObject(request)) return ['request must be an object'];
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isText(request.request_id, 64)) errors.push('request_id invalid');
  if (!isInt(request.epoch, 1)) errors.push('epoch invalid');
  if (!isInt(request.base_graph_version, 0)) errors.push('base_graph_version invalid');
  if (!isInt(request.input_version, 0)) errors.push('input_version invalid');
  errors.push(...checkSourceList(request.sources));
  if (request.context !== undefined) {
    if (!isObject(request.context)) errors.push('context must be an object');
    else {
      const c = request.context;
      if (c.active_scene !== null && c.active_scene !== undefined && !isObject(c.active_scene)) {
        errors.push('context.active_scene must be an object or null');
      }
      for (const key of ['nodes', 'edges', 'recent_scenes', 'unresolved']) {
        if (c[key] !== undefined && !Array.isArray(c[key])) errors.push(`context.${key} must be an array`);
      }
      if (Array.isArray(c.recent_scenes) && c.recent_scenes.length > LIMITS.maxRecentScenes) {
        errors.push(`context.recent_scenes exceeds ${LIMITS.maxRecentScenes}`);
      }
    }
  }
  return errors;
}

function checkScene(scene, requestId, { requireNew }) {
  const errors = [];
  if (!isObject(scene)) return ['scene must be an object'];
  const ref = scene.id || 'scene';
  if (requireNew && !idOwnedBy(scene.id, requestId, 'scene')) errors.push(`${ref}: new scene id not in request namespace`);
  if (!isText(scene.title, LIMITS.maxTitle)) errors.push(`${ref}: title invalid`);
  if (!oneOf(scene.family, FAMILIES)) errors.push(`${ref}: family invalid`);
  return errors;
}

function checkNode(node, requestId, { requireNew }) {
  const errors = [];
  if (!isObject(node)) return ['node must be an object'];
  const ref = node.id || 'node';
  if (requireNew && !idOwnedBy(node.id, requestId, 'node')) errors.push(`${ref}: new node id not in request namespace`);
  if (!isText(node.label, LIMITS.maxLabel)) errors.push(`${ref}: label invalid`);
  if (!isText(node.scene_id, 64)) errors.push(`${ref}: scene_id invalid`);
  if (node.role !== undefined && !isText(node.role, 24, { allowEmpty: true })) errors.push(`${ref}: role invalid`);
  if (!oneOf(node.claim_kind, CLAIM_KINDS)) errors.push(`${ref}: claim_kind invalid`);
  if (node.speaker_id !== undefined && !isText(node.speaker_id, LIMITS.maxSpeaker, { allowEmpty: true })) {
    errors.push(`${ref}: speaker_id invalid`);
  }
  if (node.state !== undefined && !oneOf(node.state, ['supported', 'tentative'])) {
    errors.push(`${ref}: state must be supported or tentative; use retract op to retract`);
  }
  errors.push(...checkEvidence(node.evidence).map((e) => `${ref}: ${e}`));
  return errors;
}

function checkEdge(edge, requestId, { requireNew }) {
  const errors = [];
  if (!isObject(edge)) return ['edge must be an object'];
  const ref = edge.id || 'edge';
  if (requireNew && !idOwnedBy(edge.id, requestId, 'edge')) errors.push(`${ref}: new edge id not in request namespace`);
  if (!isText(edge.scene_id, 64)) errors.push(`${ref}: scene_id invalid`);
  if (!isText(edge.from, 64)) errors.push(`${ref}: from invalid`);
  if (!isText(edge.to, 64)) errors.push(`${ref}: to invalid`);
  if (edge.from && edge.to && edge.from === edge.to) errors.push(`${ref}: self loop`);
  if (!oneOf(edge.relation, RELATIONS)) errors.push(`${ref}: relation invalid`);
  if (edge.label !== undefined && !isText(edge.label, LIMITS.maxLabel, { allowEmpty: true })) {
    errors.push(`${ref}: label invalid`);
  }
  if (!oneOf(edge.claim_kind, CLAIM_KINDS)) errors.push(`${ref}: claim_kind invalid`);
  if (edge.speaker_id !== undefined && !isText(edge.speaker_id, LIMITS.maxSpeaker, { allowEmpty: true })) {
    errors.push(`${ref}: speaker_id invalid`);
  }
  if (edge.state !== undefined && !oneOf(edge.state, ['supported', 'tentative'])) {
    errors.push(`${ref}: state must be supported or tentative; use retract op to retract`);
  }
  errors.push(...checkEvidence(edge.evidence).map((e) => `${ref}: ${e}`));
  return errors;
}

/** 校验一批操作的结构（不依赖当前图）。 */
export function checkOps(ops, requestId) {
  const errors = [];
  if (!Array.isArray(ops)) return ['ops must be an array'];
  if (ops.length > LIMITS.maxOps) errors.push(`ops exceeds ${LIMITS.maxOps}`);
  const newIds = new Set();
  const claim = (id) => {
    if (newIds.has(id)) errors.push(`duplicate new id ${id}`);
    newIds.add(id);
  };
  ops.forEach((op, i) => {
    if (!isObject(op)) {
      errors.push(`ops[${i}] must be an object`);
      return;
    }
    if (!oneOf(op.op, OP_TYPES)) {
      errors.push(`ops[${i}]: unknown op ${JSON.stringify(op.op)}`);
      return;
    }
    switch (op.op) {
      case 'create_scene': {
        const e = checkScene(op.scene, requestId, { requireNew: true });
        errors.push(...e.map((x) => `ops[${i}].create_scene: ${x}`));
        if (op.scene && idOwnedBy(op.scene.id, requestId, 'scene')) claim(op.scene.id);
        break;
      }
      case 'update_scene': {
        if (!isObject(op.scene) || !isText(op.scene.id, 64)) errors.push(`ops[${i}].update_scene: scene.id invalid`);
        else {
          if (op.scene.title !== undefined && !isText(op.scene.title, LIMITS.maxTitle)) {
            errors.push(`ops[${i}].update_scene: title invalid`);
          }
          if (op.scene.family !== undefined && !oneOf(op.scene.family, FAMILIES)) {
            errors.push(`ops[${i}].update_scene: family invalid`);
          }
        }
        break;
      }
      case 'upsert_node': {
        const e = checkNode(op.node, requestId, { requireNew: op.node && !parseId(op.node.id) });
        errors.push(...e.map((x) => `ops[${i}].upsert_node: ${x}`));
        if (op.node && idOwnedBy(op.node.id, requestId, 'node')) claim(op.node.id);
        else if (op.node && typeof op.node.id === 'string' && parseId(op.node.id)?.requestId === requestId) {
          errors.push(`ops[${i}].upsert_node: id not valid for node`);
        }
        break;
      }
      case 'upsert_edge': {
        const e = checkEdge(op.edge, requestId, { requireNew: op.edge && !parseId(op.edge.id) });
        errors.push(...e.map((x) => `ops[${i}].upsert_edge: ${x}`));
        if (op.edge && idOwnedBy(op.edge.id, requestId, 'edge')) claim(op.edge.id);
        else if (op.edge && typeof op.edge.id === 'string' && parseId(op.edge.id)?.requestId === requestId) {
          errors.push(`ops[${i}].upsert_edge: id not valid for edge`);
        }
        break;
      }
      case 'retract': {
        if (!isText(op.id, 64)) errors.push(`ops[${i}].retract: id invalid`);
        if (op.reason !== undefined && !isText(op.reason, 80, { allowEmpty: true })) {
          errors.push(`ops[${i}].retract: reason invalid`);
        }
        break;
      }
      case 'focus': {
        if (!isText(op.scene_id, 64)) errors.push(`ops[${i}].focus: scene_id invalid`);
        if (!Array.isArray(op.ids) || op.ids.length === 0) errors.push(`ops[${i}].focus: ids must be a non-empty array`);
        else if (op.ids.length > LIMITS.maxNodesPerScene) errors.push(`ops[${i}].focus: too many ids`);
        break;
      }
      case 'activate_scene': {
        if (!isText(op.scene_id, 64)) errors.push(`ops[${i}].activate_scene: scene_id invalid`);
        break;
      }
      default:
        break;
    }
  });
  return errors;
}

/** 校验模型响应的外层结构；操作细节由 Store 在副本上按当前图校验。 */
export function checkUnderstandResponse(response, request) {
  const errors = [];
  if (!isObject(response)) return ['response must be an object'];
  if (response.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (response.request_id !== request.request_id) errors.push('request_id mismatch');
  if (response.epoch !== request.epoch) errors.push('epoch mismatch');
  if (response.base_graph_version !== request.base_graph_version) errors.push('base_graph_version mismatch');
  if (!isInt(response.input_version, 0)) errors.push('input_version invalid');
  if (!oneOf(response.status, RESPONSE_STATUS)) errors.push('status invalid');
  if (!Array.isArray(response.considered)) errors.push('considered must be an array');
  else {
    const allowed = new Set((request.sources || []).map((s) => `${s.segment_id}@${s.revision}`));
    response.considered.forEach((c, i) => {
      if (!isObject(c) || !isText(c.segment_id, 64) || !isInt(c.revision, 1)) {
        errors.push(`considered[${i}] invalid`);
        return;
      }
      if (!allowed.has(`${c.segment_id}@${c.revision}`)) errors.push(`considered[${i}] not in request sources`);
    });
  }
  if (!Array.isArray(response.unresolved)) errors.push('unresolved must be an array');
  else {
    if (response.unresolved.length > LIMITS.maxUnresolved) errors.push('unresolved exceeds limit');
    response.unresolved.forEach((u, i) => {
      if (!isObject(u) || !isText(u.text, 200)) errors.push(`unresolved[${i}] invalid`);
      else if (u.evidence !== undefined) {
        errors.push(...checkEvidence(u.evidence, { max: 4 }).map((e) => `unresolved[${i}]: ${e}`));
      }
    });
  }
  if (response.status === 'degraded') {
    if (response.ops && (!Array.isArray(response.ops) || response.ops.length)) errors.push('degraded must not carry ops');
  } else {
    if (!Array.isArray(response.ops)) errors.push('ops must be an array');
    if (response.status === 'hold' && Array.isArray(response.ops) && response.ops.length) {
      errors.push('hold must not carry ops');
    }
  }
  if (response.reason !== undefined && !oneOf(response.reason, DEGRADE_REASONS)) {
    errors.push('reason invalid');
  }
  return errors;
}
