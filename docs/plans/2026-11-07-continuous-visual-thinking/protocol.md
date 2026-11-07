# 数据与接口协议 v1

本文定义待开发接口，不是现有接口文档。旧 `/api/direct*` 继续使用原协议。

## 1. 输入事件

```json
{
  "kind": "transcript",
  "epoch": 1,
  "segment_id": "seg_01",
  "order": 1,
  "revision": 2,
  "phase": "partial",
  "text": "工具越来越多，所以需要反复切换",
  "speaker_id": "unknown",
  "audio_start_ms": 0,
  "audio_end_ms": 4200,
  "received_at_ms": 4350
}
```

- 所有时间为会话相对单调时间；音频时间与接收时间分别记录，不能混为一谈。
- `order` 在采集开始时分配。同一个 segment 的内容按更高 revision **替换**，不能逐次拼接重复前缀。
- 每次发出 ASR 请求前分配 revision 并绑定音频段；响应顺序不决定版本。
- `phase` 为 `partial/final`。final 封口；迟到的 partial 即使携带错误的较大 revision 也不得覆盖它。
- 更高 revision 的 final 可纠正较早 final；这种输入会触发证据失效和重算。相同 ID/revision 不同文本视为协议冲突，不静默接受。
- 相同事件重复送达幂等；不同段 final 按 `order` 还原讲话顺序。
- 没有说话人识别时固定为 `unknown`，不猜人名。第一版可由文本回放提供可靠的 speaker ID。

Ledger 产生自己的递增 `input_version`。ASR final 只表示识别完成，不表示句意完整，更不表示事实真实。

## 2. 语义状态

```text
SemanticState
  schema_version: 1
  epoch / graph_version
  active_scene_id
  scenes: { scene_id -> Scene }
  nodes: { node_id -> Node }
  edges: { edge_id -> Edge }
  receipts: { segment_id -> 已成功考虑的 revision }
  unresolved: [{ text, evidence }]
  history: 最近场景和修改记录
```

Scene 包含 `id/title/family/node_ids/edge_ids/focus_ids/status`。`family` 允许 `cause/compare/composition/convergence/text`。`text` 是合法的中性表达，不能因没有关系而硬造结构。

Node 包含 `id/scene_id/label/role/claim_kind/speaker_id/evidence/state`。

Edge 包含 `id/scene_id/from/to/relation/label/claim_kind/speaker_id/evidence/state`。

`relation` 允许 `causes/contrasts/part_of/converges_to/sequence/conditional`。四种专用场景以外的关系，第一版可以使用中性文本解释，不能错误地套成因果箭头。`part_of` 的方向为“部分 → 整体”；`converges_to` 为“来源 → 汇聚目标”；`contrasts` 为对称关系，禁止画因果箭头。

`claim_kind` 为 `assertion/hypothesis/question/proposal/quotation`；`state` 为 `tentative/supported/stale/retracted`。

`supported` 只表示讲话已明确表达且来源有效，不表示客观事实被核验；问题、设想即使来源明确也要保留自己的 claim_kind。

## 3. 证据与身份

```json
{"segment_id":"seg_01","revision":2,"quote":"工具越来越多，所以需要反复切换"}
```

quote 必须能在指定 revision 原文中逐字找到。第一版使用原文片段校验，不引入易混淆的字符偏移。模型输出标签可做忠实概括，但不能改写输入账本来让证据匹配。

节点或关系可以引用多个证据片段。一条跨句因果关系必须引用足以支持其含义的片段；仅仅引用两个相邻名词，不构成语义质量通过。程序验证来源有效，人工/模型评测验证是否支持该关系，两者不可混同。

来源 revision 被替换时，引用它的对象或关系标记 `stale` 并重新计算。多来源对象也要重新评估，不允许继续凭失效来源展示强结论；未受影响的对象保持原样。

现有对象沿用 ID，标签改变不改 ID；相同标签不代表相同对象。新 ID 采用宿主传入的 request ID 命名空间：`s_<requestId>_<序号>`、`n_<requestId>_<序号>`、`e_<requestId>_<序号>`。程序校验唯一性，模型只引用合法已有 ID 或本批新 ID。

## 4. 请求

新增 `POST /api/understand`，JSON 请求；会话状态由浏览器持有，第一版服务端不创建数据库。

```json
{
  "schema_version": 1,
  "request_id": "r07",
  "epoch": 1,
  "base_graph_version": 3,
  "input_version": 6,
  "sources": [
    {"segment_id":"seg_01","revision":2,"order":1,"phase":"partial","text":"工具越来越多，所以需要反复切换","speaker_id":"unknown"}
  ],
  "context": {
    "active_scene": null,
    "nodes": [],
    "edges": [],
    "recent_scenes": [],
    "unresolved": []
  }
}
```

`sources` 包含未消费 final、最新 partial 及所需上下文。上下文带来的原文同样作为可验证 sources；不能用模型自己生成的摘要充当原话证据。

调用前保存完整请求快照，响应回来按该快照与当前账本共同校验。首批 UI 控制使用独立事件，讲话文本中的“清空”“不要听前文”等不能直接当作应用命令。

## 5. 响应与原子操作

```json
{
  "schema_version": 1,
  "request_id": "r07",
  "epoch": 1,
  "base_graph_version": 3,
  "input_version": 6,
  "status": "ok",
  "considered": [{"segment_id":"seg_01","revision":2}],
  "ops": [
    {"op":"create_scene","scene":{"id":"s_r07_1","title":"为什么切换变多","family":"cause"}},
    {"op":"upsert_node","node":{"id":"n_r07_1","scene_id":"s_r07_1","label":"工具增多","role":"concept","claim_kind":"assertion","speaker_id":"unknown","state":"supported","evidence":[{"segment_id":"seg_01","revision":2,"quote":"工具越来越多"}]}},
    {"op":"upsert_node","node":{"id":"n_r07_2","scene_id":"s_r07_1","label":"反复切换","role":"concept","claim_kind":"assertion","speaker_id":"unknown","state":"supported","evidence":[{"segment_id":"seg_01","revision":2,"quote":"需要反复切换"}]}},
    {"op":"upsert_edge","edge":{"id":"e_r07_1","scene_id":"s_r07_1","from":"n_r07_1","to":"n_r07_2","relation":"causes","label":"导致","claim_kind":"assertion","speaker_id":"unknown","state":"supported","evidence":[{"segment_id":"seg_01","revision":2,"quote":"工具越来越多，所以需要反复切换"}]}},
    {"op":"focus","scene_id":"s_r07_1","ids":["n_r07_2"]}
  ],
  "unresolved": []
}
```

这个示例的文字、关系和来源来自虚构验收输入，不是实际模型结果。

| 操作 | 语义 |
| --- | --- |
| `create_scene` | 建立新观点或容量续接场景；普通新词不是换场景理由 |
| `update_scene` | 更新标题/family；变更必须仍忠实于现有图，不为追求多样强换布局 |
| `upsert_node` | 新增或更正对象；更新已有对象时保留 ID |
| `upsert_edge` | 建立或更正关系；端点、类型与证据均有效 |
| `retract` | 将指定 node/edge 标为撤回，保留历史；撤回 node 时原子撤回相连边 |
| `focus` | 改变强调对象，不新增事实 |
| `activate_scene` | 显式回看；修正归档本身不隐式跳转 |

同一 scene 已存在时复用它。`status` 为 `ok/hold/degraded`。`hold` 的 ops 为空，可以更新 unresolved；`degraded` 不消费输入、不修改图。

最多 12 个 ops；预算不足时只提交已完整表达的一批，剩余输入不能报告为已考虑。超出 ops 上限或缺字段时拒绝整批，不截断 JSON 或手工修补缺失的逻辑。

## 6. 提交规则

按以下顺序在副本验证，全部通过才提交：

1. schema、字段类型、长度和数目边界；未知 op 明确拒绝。
2. request/epoch 必须属于在途请求，重复响应幂等。
3. base_graph_version 必须等于当前图版本；不一致不自动覆盖。
4. 依赖的 source revision 仍与当前账本一致。只新增输入、不修改旧来源时允许提交，不要求 input_version 仍相同。
5. `considered` 只能包含请求中有的 sources；它表示模型已经纳入判断，不表示必须上屏或关系必然正确。
6. 证据存在且原文匹配；边端点、场景归属、ID 引用合法。因果/组成等关系不能自环；第一版有向因果与组成图禁止循环，反馈环另行设计。
7. 所有修改按一批原子生效，graph_version 加一，再更新 receipts；任一步失败不产生部分图或部分消费。

没有考虑的 final 继续等待。部分考虑某一段内部内容时，v1 不提供字符级 receipt：该段不能标为已考虑，保留它重算，通过稳定 ID 防重复。不能用“只显示最后一句”冒充合并完成。

## 7. 边界和失败响应

建议初始边界：sources 原文合计 6000 中文字符、每请求最多 24 个 source 版本、每标签最多 28 字、场景标题最多 32 字、证据片段最多 160 字。超限返回可解释错误或由客户端有序分批；不能截掉“不、可能、仅当”等限定词。当前可见节点上限与原始信息保存分别管理。

HTTP 非法参数用 400、体积超限用 413，服务异常用适当 5xx；无 Key/模型失败的正常降级可返回 `status:degraded`、空 ops/considered 以及 `reason:no_key/timeout/invalid_output/upstream_error`。前端不能把降级包装成模型成功。

服务端复用本机请求校验。模型超时与客户端断开必须能取消上游请求。日志可以记录 request ID、耗时、tokens、拒绝原因，不记录 Key；默认不落盘原始音频和全文。用户主动导出回放/评测时才保存相关本地资料。
