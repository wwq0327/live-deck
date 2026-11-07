// 语义模块测试用的最小构造器：真实账本 + 真实 Store，不 mock 协议。
import { SemanticStore } from '../../public/semantic/store.js';
import { TranscriptLedger } from '../../public/semantic/transcript.js';
import { makeId, SCHEMA_VERSION } from '../../public/semantic/protocol.js';

export function makeEnv({ epoch = 1, now = () => Date.now() } = {}) {
  const ledger = new TranscriptLedger({ epoch, now });
  const store = new SemanticStore({ epoch, ledger });
  return { ledger, store, now };
}

/** 按讲话顺序灌入若干 final 段，返回 segment_id 列表。 */
export function seedSegments(ledger, texts, { order = 0, orderBase } = {}) {
  const ids = [];
  const base = orderBase ?? ledger.nextOrder();
  texts.forEach((text, i) => {
    const segment_id = `seg${order + i + 1}`;
    const seq = base;
    const r = ledger.ingest({
      kind: 'transcript',
      epoch: ledger.epoch,
      segment_id,
      order: seq + i,
      revision: 1,
      phase: 'final',
      text,
    });
    if (!r.ok) throw new Error(`seed failed: ${r.code} ${r.reason}`);
    ids.push(segment_id);
  });
  return ids;
}

export function buildRequest(store, ledger, requestId, { sources, context } = {}) {
  const built = ledger.buildSources();
  return {
    schema_version: SCHEMA_VERSION,
    request_id: requestId,
    epoch: store.epoch,
    base_graph_version: store.graphVersion,
    input_version: ledger.input_version,
    sources: sources || built.sources,
    context: context || {
      ...store.graphView(),
      recent_scenes: store.recentScenes(),
    },
  };
}

export function scene(requestId, seq, title, family = 'cause') {
  return { op: 'create_scene', scene: { id: makeId('scene', requestId, seq), title, family } };
}

export function node(requestId, seq, sceneId, label, evidence, extra = {}) {
  return {
    op: 'upsert_node',
    node: {
      id: makeId('node', requestId, seq),
      scene_id: sceneId,
      label,
      role: extra.role || 'concept',
      claim_kind: extra.claim_kind || 'assertion',
      speaker_id: extra.speaker_id || 'unknown',
      evidence,
      ...extra,
    },
  };
}

export function edge(requestId, seq, sceneId, from, to, relation, evidence, extra = {}) {
  return {
    op: 'upsert_edge',
    edge: {
      id: makeId('edge', requestId, seq),
      scene_id: sceneId,
      from,
      to,
      relation,
      label: extra.label || '',
      claim_kind: extra.claim_kind || 'assertion',
      speaker_id: extra.speaker_id || 'unknown',
      evidence,
      ...extra,
    },
  };
}

export function evidence(segment_id, quote, revision = 1) {
  return { segment_id, revision, quote };
}

/** 发起请求并提交一包响应；自动 beginRequest。 */
export function respond(store, ledger, request, ops, { considered = [], status = 'ok', unresolved = [] } = {}) {
  const begin = store.beginRequest(request);
  if (!begin.ok) throw new Error(`beginRequest failed: ${begin.code}`);
  return store.commit(
    {
      schema_version: SCHEMA_VERSION,
      request_id: request.request_id,
      epoch: request.epoch,
      base_graph_version: request.base_graph_version,
      input_version: request.input_version,
      status,
      considered: considered.length
        ? considered
        : request.sources.map((s) => ({ segment_id: s.segment_id, revision: s.revision })),
      ops,
      unresolved,
    },
    request,
    { ledger }
  );
}
