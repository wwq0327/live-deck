// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C14",
  "title": "保持画面/恢复/重置的输入侧行为",
  "duration_ms": 8000,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c14-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "先把画面保持住，我继续说"
      }
    },
    {
      "at_ms": 1000,
      "control": "hold"
    },
    {
      "at_ms": 2000,
      "event": {
        "kind": "transcript",
        "segment_id": "c14-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "这段是在保持画面时说的补充"
      }
    },
    {
      "at_ms": 3000,
      "control": "resume"
    },
    {
      "at_ms": 4000,
      "event": {
        "kind": "transcript",
        "segment_id": "c14-3",
        "order": 3,
        "revision": 1,
        "phase": "final",
        "text": "现在回到最新内容"
      }
    },
    {
      "at_ms": 6000,
      "control": "reset"
    },
    {
      "at_ms": 7000,
      "event": {
        "kind": "transcript",
        "segment_id": "c14-4",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "重置之后的新会话"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 5500,
      "expect": {
        "segment_count": 3,
        "pending_count": 3
      }
    },
    {
      "at_ms": 8000,
      "expect": {
        "segment_count": 1,
        "final_texts": [
          "重置之后的新会话"
        ],
        "input_version": 1,
        "pending_count": 1
      }
    }
  ]
};
