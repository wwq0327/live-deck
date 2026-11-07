// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C12",
  "title": "因果链逐段延长",
  "duration_ms": 6000,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c12-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "问题变多了"
      }
    },
    {
      "at_ms": 1200,
      "event": {
        "kind": "transcript",
        "segment_id": "c12-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "因为入口太深"
      }
    },
    {
      "at_ms": 2400,
      "event": {
        "kind": "transcript",
        "segment_id": "c12-3",
        "order": 3,
        "revision": 1,
        "phase": "final",
        "text": "入口深让新用户迷路"
      }
    },
    {
      "at_ms": 3600,
      "event": {
        "kind": "transcript",
        "segment_id": "c12-4",
        "order": 4,
        "revision": 1,
        "phase": "final",
        "text": "迷路带来重复注册"
      }
    },
    {
      "at_ms": 4800,
      "event": {
        "kind": "transcript",
        "segment_id": "c12-5",
        "order": 5,
        "revision": 1,
        "phase": "final",
        "text": "重复注册又增加支持成本"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 6000,
      "expect": {
        "segment_count": 5,
        "pending_count": 5
      }
    }
  ]
};
