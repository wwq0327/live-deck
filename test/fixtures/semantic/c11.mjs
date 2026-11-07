// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C11",
  "title": "上游失败时输入仍完整保留",
  "duration_ms": 2000,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c11-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "上游超时也不能丢掉这句话"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 2000,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "上游超时也不能丢掉这句话"
        ],
        "pending_count": 1
      }
    }
  ]
};
