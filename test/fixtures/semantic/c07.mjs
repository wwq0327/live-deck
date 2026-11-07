// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C07",
  "title": "过去判断与当前判断不同；后文排除旧原因",
  "duration_ms": 4200,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c07-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "我以前觉得速度最重要，后来发现，理解内容比速度更重要。"
      }
    },
    {
      "at_ms": 2400,
      "event": {
        "kind": "transcript",
        "segment_id": "c07-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "不是低价带来增长，是新入口带来了更多访问。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 4200,
      "expect": {
        "segment_count": 2,
        "final_texts": [
          "我以前觉得速度最重要，后来发现，理解内容比速度更重要。",
          "不是低价带来增长，是新入口带来了更多访问。"
        ],
        "pending_count": 2
      }
    }
  ]
};
