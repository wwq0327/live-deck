# 排障

## 先看这两个地方

```bash
curl -s http://127.0.0.1:4400/api/health | python3 -m json.tool
```

```json
{
  "ok": true,
  "hasKey": true,
  "model": "deepseek-flash",
  "asr": {
    "ready": true, "loading": false,
    "backend": "sensevoice", "model": "sensevoice-int8",
    "error": "", "queued": 0, "finals": 12, "partials": 31,
    "lastMs": 87, "lastText": "以前做一份演示要花三四个小时"
  }
}
```

- `hasKey: false` → 会走本地规则，能出页但很笨。
- `asr.ready: false` → 看 `asr.error`（模型路径错了、venv 没装、Python 版本不对）。
- `asr.lastText` 是最近一次转写，用来判断"到底听没听到"。

服务端日志在启动它的那个终端里，每句一行：

```
[asr]    final      87ms   3.9s 以前做一份演示要花三四个小时
[direct] model     1127ms new_slide compare  从三小时到一句话
[direct] ahead      980ms new_slide band     让 PPT 跟着你说话
```

## 起不来

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE` | 4400 被占 | `pkill -f "node server.mjs"`，或 `PORT=4401 node server.mjs` |
| 页面 404 | 不在项目根目录启动 | `node server.mjs` 必须在仓库根目录跑 |
| `node: command not found` | 需要 Node ≥ 20 | `node -v` 看一眼 |
| 服务起来了但页面全白 | `public/` 被删或路径不对 | `curl -I http://127.0.0.1:4400/` 看是不是 200 |

## 麦克风

**第一个要排除的：是不是在别的应用的内嵌窗口里打开。** 只有浏览器自己的标签页才有麦克风权限。

页面里点麦克风失败时，会弹一张诊断卡，上面六行就是全部线索：

| 行 | 含义 |
| --- | --- |
| 错误 | 浏览器给的原名，如 `NotAllowedError · Permission denied` |
| 含义 | 人话翻译 |
| 地址 | 当前 URL（必须是 `http://127.0.0.1` 或 `https`） |
| 安全上下文 | 不是 `true` 就永远拿不到麦克风 |
| 在 iframe 里 | `true` 的话外层页面得允许 `allow="microphone"` |
| 浏览器权限 | `prompt` / `granted` / `denied` |
| 输入设备 | 0 个说明系统没认到麦克风 |

三种典型：

1. **`NotAllowedError` + 权限 `denied`**：点地址栏左边的小锁/图标 → 麦克风 → 允许 → 刷新。
2. **权限 `granted` 但还是失败**：macOS 系统层没给浏览器麦克风。系统设置 → 隐私与安全性 → 麦克风 → 勾上你用的浏览器 → **完全退出浏览器再打开**（⌘Q，不是关窗口）。
3. **`NotFoundError`**：没插麦克风，或者被别的声音设备占了。

修完点诊断卡上的「改好了，再试一次」。

## 没声音 / 出页很慢

**先确认是不是转写的问题**——把一段 `.wav` 直接拖进页面，它走完全相同的管线：

- 拖进去也慢 → 是导演/网络的问题。
- 拖进去很快、只有麦克风慢 → 是 VAD 或设备的问题。

再看 `asr.lastMs`：正常是一句话 50–140ms（SenseVoice）。如果是 600ms+，可能是：

- `ASR_BACKEND=whisper` 但用的是 large 模型 → 换 `ASR_MODEL=small` 或 `tiny`。
- 第一次请求（模型还在加载）→ 等 1–2 秒，`asr.loading` 会变 `false`。
- CPU 被别的进程吃满 → `ASR_THREADS` 调小反而可能更快（默认 2）。

**导演慢**（>`[direct]` 那一行 2000ms）：检查是不是忘了关思考。请求体里必须有 `thinking: {"type":"disabled"}`；`max_tokens` 压得太低（比如 120）会让思考链吃光配额、`content` 为空。

## 页面在跳

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一句话翻出两三页 | VAD 把一句话切成了几段（句内停顿 > 0.42s） | 说话连贯一点；或者把 `stage.js` 里 `CLOSE_MS` 调大（0.42 → 0.6） |
| 页面来回换构图 | 占位页在 2.4s 内允许换版式 | 正常现象。嫌跳就把 `morph()` 里的 `young` 阈值调小 |
| 字幕闪 | partial 结果不稳定 | 正常现象，partial 只更新字幕、不动页面 |
| 出现重复的一页 | 两句转写文本碰巧一样 | `show()` 里有标题去重，撞上会走 `morph()` |

## 转写不准

- **同音字**：SenseVoice 会把"一份"听成"一粉"、"PPT"听成"TTT"。拉丁词靠 `asr_worker.py` 的 `FIXUPS` 正则修；汉字靠导演提示词按上下文改。
- **专业名词**：`ASR_BACKEND=whisper` 更准（但慢 5–10 倍）；whisper 可以用 `initial_prompt` 给词表，**但 prompt 里绝对不能有全角标点**——否则输出里所有逗号会变成 `Ｂ`（U+FF22）。
- **环境吵**：能量 VAD 会被噪声带偏。下一步换 Silero VAD，见 [roadmap](roadmap.md)。

## 调试开关

```
?debug=1     window.__log 里记录 show / morph / decide / derive 的每一步
?clean=1     隐藏 HUD 和字幕（截图用）
?mic=1       打开就开麦
?autoplay=1  自动跑演示
?preview=X   单独预览某一种版式
```

`?debug=1` 之后在控制台：

```js
__log.slice(-20)      // 最近 20 条事件
__d.recent            // 最近三页的构图
__d.state             // 整个前端状态机
```

## 日志里值得盯的三个数

```
[asr]    final   87ms   3.9s  <转写文本>      ← 转写延迟
[direct] model 1127ms new_slide compare …    ← 决策延迟
HUD: 0.00S · 预生成                            ← 收句到出页的端到端
```

前两个加起来 ≈ HUD 那个数（如果没命中预生成）。三者任何一个大得离谱，就能定位到是哪一段。
