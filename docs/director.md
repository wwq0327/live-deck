# 导演协议

"导演"是这条管线里唯一的模型调用。它不写页面，只写一条指令：**这一页用哪种构图、上面写什么字。**

## 请求

```
POST /api/direct
Content-Type: application/json

{
  "transcript": "大家好，今天我想聊一个很小的想法… 以前做一份演示要花三四个小时。",
  "current":    { "layout": "split", "title": "让 PPT 跟着你说话", "provisional": true },
  "mode":       "decide",
  "purpose":    "ahead"
}
```

| 字段 | 说明 |
| --- | --- |
| `transcript` | 到这一刻为止的**全部**转写（服务端截最近 900 字） |
| `current` | 当前屏幕上的页；没有就传 `null` |
| `current.provisional` | `true` 表示这一页是占位草稿，允许整页重写 |
| `mode` | `decide`（现在该显示什么）/ `predict`（预判下一句） |
| `purpose` | 只用于服务端日志：`model`（收句定稿）/ `ahead`（说话中）/ `predict` |

服务端会把 `transcript` 切成两段再喂给模型：

```
当前页：{...}
刚才说过的（背景，不要重复画）：「以前做一份演示要花三四个小时。现在你只要开口。」
刚说的这一句：「关键不是生成是节奏，说完一句，停一下画面就切。」

这一句该显示什么？
```

切分点：按 `。！？!?\n` 切，最后一段是"这一句"，前 3 段是"背景"。**这个切分是提示词能听话的关键**——只给整段 `transcript`，模型会反复拿最有画面感的那句出页。

## 响应

```json
{
  "action": "new_slide",
  "layout": "compare",
  "kicker": "对比",
  "title": "从三小时到一句话",
  "subtitle": "",
  "points": [],
  "steps": [],
  "left":  { "label": "以前", "value": "三四个小时" },
  "right": { "label": "现在", "value": "开口就行" },
  "stat":  { "value": "1.2", "unit": "秒", "label": "端到端" },
  "quote": { "text": "…", "by": "…" },
  "accent": "#FF5A2B",
  "add_points": [],
  "ms": 1127,
  "source": "model",
  "model": "deepseek-flash"
}
```

`source` 三选一：`model`（模型返回）/ `heuristic`（没 Key）/ `fallback`（调用失败，附带 `error`）。

## 流式接口

`POST /api/direct/stream` 的请求体与 `/api/direct` 相同，返回 `application/x-ndjson`，一行一个事件：

```json
{"type":"partial","title":"从三小时到一分钟"}
{"type":"done","result":{ "action":"new_slide", "layout":"compare", ... }}
```

- 提示词把 `title` 放在 JSON 第一个字段；服务端一旦从上游流里拿到闭合的 `title` 字符串，就先发 `partial`，前端直接改当前占位页的标题，不等整包 JSON。
- 完整结果仍由 `done` 送达；`result` 的字段与 `/api/direct` 完全一致。
- 没有 Key、上游报错、超时都仍会走 `heuristic`/`fallback`，只发 `done`，不会让流悬挂。
- 当前只流式送 `title`；正文（points/stat/left/right）仍要等完整 JSON。

## action 的语义

| action | 前端怎么消费 |
| --- | --- |
| `new_slide` | 话题换了才翻页；同一句话内 → `morph()` 原地改写 |
| `patch` | 只追加 `add_points`（列表类构图最多补到 3 条），不换页 |
| `noop` | 什么都不做 |

服务端会做两次降级，避免前端收到空指令：

- `patch` 但 `add_points` 为空 → 改成 `noop`
- `new_slide` 但既没有 `title`，也没有 `stat.value`/`stats`/`quote.text`/`points`/`steps`/`left`/`right` → 改成 `noop`

## layout 的取值

模型可以给这八种（老的语义层）：`title` / `bullets` / `bigidea` / `stat` / `stats` / `compare` / `steps` / `quote`。

**注意**：模型给的 `layout` 只是"内容形状"的建议，前端 `derive()` 会再映射一次到十三种构图（`hero`/`band`/`split`/`cards`/`chips`/`stats`…），并做防重复轮换。见 [layouts.md](layouts.md)。

## 字段上限（`normalize()` 里硬裁）

| 字段 | 上限 |
| --- | --- |
| `kicker` | 8 字 |
| `title` | 20 字 |
| `subtitle` | 34 字 |
| `points` / `add_points` | 每条 20 字，`points` 最多 3 条，`add_points` 最多 2 条 |
| `steps` | 每条 18 字，最多 3 条 |
| `left/right.value` | 16 字 |
| `stat.value` | 8 字，`unit` 4 字 |
| `stats` | 最多 3 项；每项 `value` 8 字、`unit` 4 字、`label` 20 字 |
| `quote.text` | 48 字 |

超了不会报错，直接截断——**宁可少写，也不要让排版崩掉**。

## 调用参数

```js
{
  model: process.env.DIRECTOR_MODEL || 'deepseek-flash',
  response_format: { type: 'json_object' },
  thinking: { type: 'disabled' },        // 关键：关掉思考链
  temperature: mode === 'predict' ? 0.9 : 0.65,
  max_tokens: mode === 'predict' ? 220 : 400,
}
```

超时 9 秒（`AbortController`），失败回退启发式。

### 为什么一定要关思考

同一段中文、同样输出约 120 token 的 JSON：

| 设置 | 耗时 | 备注 |
| --- | --- | --- |
| 默认（带思考） | 1.9 – 2.6s | `reasoning_tokens` 80–240 |
| `thinking: {type:"disabled"}` | **0.6 – 1.0s** | 无 reasoning |

试过但**无效**的两个：`enable_thinking: false`、`chat_template_kwargs`。
另有一个坑：`max_tokens` 压到 120 会被思考链吃掉，`content` 直接为空——所以关思考，并给 decide 留 400、给更短的 predict 留 220 的余量。

## 提示词

`SYSTEM` 全文在 `director.mjs` 里，结构是：角色 → 输出格式 → 12 条规则 → 2 个 few-shot。规则里最值钱的四条：

- **第 2 条**：只要最近一句带来新信息（新数字、新对比、新结论、新例子、新转折），就必须出页。话题没变 → `patch`，话题切换 → `new_slide`。
- **第 3 条**：`noop` 只留给纯口头禅、原样重复、明显没说完的半句。**不要因为"主题一样"就 noop**。
- **第 8 条**：转写可能有同音错字（份/粉、生成/声称、页/业、PPT/TTT），写页面文字时按上下文改对，不要照抄。
- **第 9/10 条**：画的是"刚说的最后一句"；当前页被标成临时草稿时允许整页重写。

### 调优记录（按时间）

| 改了什么 | 为什么 |
| --- | --- |
| 原规则"话题没变 → noop" | 导致第二三句永远卡在第一页，一条 20 分钟的讲话只有 3 页 |
| 改成"有新信息就必须出页" | 出页密度从每 7 分钟一次变成每句一次 |
| `userPrompt` 切成"背景 / 这一句" | 模型总是拿最有画面感的那句出页，句子对不上 |
| 加第 9 条"前面的话已经上屏" | 同上，双保险 |
| 加第 11 条"别每次都只给 title+subtitle" | 页面全是大字 + 小字，太单一 |
| 加第 12 条"一页只讲一件事" | 偶尔堆 5 行字，版面溢出 |
| 传 `provisional: true` | 定稿页和占位页内容重复，白费一次调用 |

## 换模型 / 换供应商

`director.mjs` 只用了 OpenAI 兼容的 `POST /chat/completions`：

```bash
DIRECTOR_MODEL=deepseek-v4-pro node server.mjs          # 同一家，更贵更慢
DEEPSEEK_BASE_URL=https://api.openai.com/v1 \
DIRECTOR_MODEL=gpt-4o-mini node server.mjs              # 换一家（环境变量里的 Key 会优先被读取）
```

换模型后要重新验三件事：JSON 是否稳定（`response_format` 支持吗）、延迟、以及关思考的参数名（DeepSeek 是 `thinking`，别家可能没有）。

## 成本

一次调用约 700 token 提示词 + 120 token 输出。按每句 3–4 次调用算，一小时讲话大约 200–300 次调用。用 flash 级模型，成本可以忽略；用 pro 级模型请先算一下。

## 无 Key 时的启发式

`heuristic()` 是一组规则，保证没有 Key 也能演示：

| 触发 | 结果 |
| --- | --- |
| 句子里有数字 | `stat` |
| 有"对比/以前/现在/但是" | `compare` |
| 有"第一/然后/最后/步骤" | `steps` |
| ≤18 字 | `bigidea` |
| 其他 | `bullets`（按逗号切） |

它不会理解语义，只保证"每句都有页面、形状不一样"。
