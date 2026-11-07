// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C13",
  "title": "超过 6 对象后回指最早对象",
  "duration_ms": 4800,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c13-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "流程有五层：入口、选择、确认、提交、完成。"
      }
    },
    {
      "at_ms": 2000,
      "event": {
        "kind": "transcript",
        "segment_id": "c13-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "另外还有权限、通知和审计三层也要算进去。"
      }
    },
    {
      "at_ms": 4000,
      "event": {
        "kind": "transcript",
        "segment_id": "c13-3",
        "order": 3,
        "revision": 1,
        "phase": "final",
        "text": "最早说的入口，其实还可以再细分。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 4800,
      "expect": {
        "segment_count": 3,
        "pending_count": 3
      }
    }
  ]
};
