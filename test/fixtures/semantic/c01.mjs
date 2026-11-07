// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C01",
  "title": "同一段 partial 连续替换，final 补齐结果",
  "duration_ms": 5000,
  "note": "final 之前就应产生语义请求（调度层断言在 S05）；此处只验账本不丢、不重、不提前封口。",
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c01-1",
        "order": 1,
        "revision": 1,
        "phase": "partial",
        "text": "资料放在微信"
      }
    },
    {
      "at_ms": 1000,
      "event": {
        "kind": "transcript",
        "segment_id": "c01-1",
        "order": 1,
        "revision": 2,
        "phase": "partial",
        "text": "资料放在微信、文档和表格里"
      }
    },
    {
      "at_ms": 2200,
      "event": {
        "kind": "transcript",
        "segment_id": "c01-1",
        "order": 1,
        "revision": 3,
        "phase": "partial",
        "text": "资料放在微信、文档和表格里，所以找东西时我得来回切换"
      }
    },
    {
      "at_ms": 4000,
      "event": {
        "kind": "transcript",
        "segment_id": "c01-1",
        "order": 1,
        "revision": 4,
        "phase": "final",
        "text": "资料放在微信、文档和表格里，所以找东西时我得来回切换。切换让我花更多时间。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 2500,
      "expect": {
        "segment_count": 1,
        "final_texts": [],
        "pending_count": 1
      }
    },
    {
      "at_ms": 5000,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "资料放在微信、文档和表格里，所以找东西时我得来回切换。切换让我花更多时间。"
        ],
        "pending_count": 1,
        "rejected_codes": []
      }
    }
  ]
};
