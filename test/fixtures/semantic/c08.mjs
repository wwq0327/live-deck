// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C08",
  "title": "口述概数不得伪造精确值",
  "duration_ms": 2400,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c08-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "最初几万，后来几千，现在只有几十，大概是这个量级。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 2400,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "最初几万，后来几千，现在只有几十，大概是这个量级。"
        ],
        "pending_count": 1
      }
    }
  ]
};
