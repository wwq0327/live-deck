// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C03",
  "title": "同场景修正原因并限定人群",
  "duration_ms": 3000,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c03-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "用户流失是因为操作太复杂。"
      }
    },
    {
      "at_ms": 1500,
      "event": {
        "kind": "transcript",
        "segment_id": "c03-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "准确说，是新用户找不到入口。"
      }
    },
    {
      "at_ms": 2800,
      "event": {
        "kind": "transcript",
        "segment_id": "c03-3",
        "order": 3,
        "revision": 1,
        "phase": "final",
        "text": "老用户没有这个问题。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 3000,
      "expect": {
        "segment_count": 3,
        "final_texts": [
          "用户流失是因为操作太复杂。",
          "准确说，是新用户找不到入口。",
          "老用户没有这个问题。"
        ],
        "pending_count": 3
      }
    }
  ]
};
