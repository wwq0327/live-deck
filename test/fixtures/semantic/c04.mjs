// 验收场景（输入层）：事件按模拟时间开放，checkpoints 只断言账本事实。
export default {
  "id": "C04",
  "title": "先后关系与不确定性必须保留",
  "duration_ms": 4200,
  "events": [
    {
      "at_ms": 0,
      "event": {
        "kind": "transcript",
        "segment_id": "c04-1",
        "order": 1,
        "revision": 1,
        "phase": "final",
        "text": "我们先换了界面，后来用户增长了。"
      }
    },
    {
      "at_ms": 2200,
      "event": {
        "kind": "transcript",
        "segment_id": "c04-2",
        "order": 2,
        "revision": 1,
        "phase": "final",
        "text": "不过我还不能确定两者有没有关系。"
      }
    }
  ],
  "checkpoints": [
    {
      "at_ms": 4200,
      "expect": {
        "segment_count": 2,
        "final_texts": [
          "我们先换了界面，后来用户增长了。",
          "不过我还不能确定两者有没有关系。"
        ],
        "pending_count": 2
      }
    }
  ]
};
