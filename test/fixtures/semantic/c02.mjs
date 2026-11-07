// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C02",
  "title": "final 否定修正后，迟到 partial 不得覆盖",
  "duration_ms": 2600,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c02-1",
        "order": 1,
        "revision": 1,
        "phase": "partial",
        "text": "这个办法能减少切换"
      }
    },
    {
      "at_ms": 1200,
      "event": {
        "kind": "transcript",
        "segment_id": "c02-1",
        "order": 1,
        "revision": 2,
        "phase": "final",
        "text": "这个办法不能减少切换"
      }
    },
    {
      "at_ms": 2000,
      "event": {
        "kind": "transcript",
        "segment_id": "c02-1",
        "order": 1,
        "revision": 1,
        "phase": "partial",
        "text": "这个办法能减少切换"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 1500,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "这个办法不能减少切换"
        ],
        "pending_count": 1
      }
    },
    {
      "at_ms": 2600,
      "expect": {
        "final_texts": [
          "这个办法不能减少切换"
        ],
        "rejected_codes": [
          "late_revision"
        ]
      }
    }
  ]
};
