// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C09",
  "title": "reset 使旧输入与在途状态失效",
  "duration_ms": 1600,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c09-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "我们先换了界面"
      }
    },
    {
      "at_ms": 500,
      "control": "reset"
    },
    {
      "at_ms": 1000,
      "event": {
        "kind": "transcript",
        "segment_id": "c09-2",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "后来用户增长了"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 600,
      "expect": {
        "segment_count": 0,
        "final_texts": [],
        "input_version": 0
      }
    },
    {
      "at_ms": 1600,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "后来用户增长了"
        ],
        "input_version": 1,
        "pending_count": 1
      }
    }
  ]
};
