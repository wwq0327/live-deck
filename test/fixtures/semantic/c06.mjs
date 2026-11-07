// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C06",
  "title": "提议与待验证效果",
  "duration_ms": 2600,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c06-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "我想做一个统一入口，希望减少切换，效果还需要试。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 2600,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "我想做一个统一入口，希望减少切换，效果还需要试。"
        ],
        "pending_count": 1
      }
    }
  ]
};
