// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C05",
  "title": "问句中的假设不能画成已确认因果",
  "duration_ms": 2200,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c05-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "会不会是价格太高，才导致用户流失？"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 2200,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "会不会是价格太高，才导致用户流失？"
        ],
        "pending_count": 1
      }
    }
  ]
};
