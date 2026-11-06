# 版式系统

模型只负责"说什么"，**怎么说好看由本地决定**。所以加一种版式不用动提示词、不用多一次调用、也不会多一毫秒延迟。

## 十三种构图

![hero](img/hero.png)

| 构图 | 长什么样 | 需要哪些字段 | 什么时候会被选中 |
| --- | --- | --- | --- |
| `hero` | 超大标语（136px）+ 右下角淡水印符号 | `title`(±`subtitle`) | 一句话金句；`bigidea` |
| `title` | 78px 标题 + 副标题，无图形 | `title`+`subtitle` | 开场页；或标题较长、需要副标题时（不再是固定 `n===0`） |
| `band` | 一整块 accent 色贴纸，深色字压在上面 | `title`(±`subtitle`) | 想强调的一句话；有副标题时的轮换位 |
| `split` | 左文右整块色板 + 240px 大图形 | `title` ± `points` | 有副标题时的轮换位 |
| `splitflip` | 同上，色板换到左边 | 同上 | `split` 撞车时的替代 |
| `cards` | 2–4 张图标卡片，三栏网格 | `points`（2–4 条、每条 ≤15 字） | 并列的短要点 |
| `chips` | 46px 胶囊，一个词一颗 | `points`（2 条以上、每条 ≤8 字） | 一串名词、清单 |
| `bullets` | 编号列表，行间细线 | `points`（3 条左右、较长） | 较长的一组要点 |
| `steps` | 三列时间线 + 圆点 + 序号 | `steps` | 有先后顺序的过程 |
| `stat` | 300px 大数字 + 单位 + 说明 | `stat:{value,unit,label}` | 单个数字；超过 6 位自动缩字号 |
| `stats` | 两个或三个大数字并排 | `stats`（2–3 个） | 多个数字并列；按 value 长度自动缩字号 |
| `compare` | 左"以前"右"现在"两栏 | `left:{label,value}` `right:{label,value}` | 对照；标题含"从 X 到 Y" |
| `quote` | 大引号 + 一句话 + 署名 | `quote:{text,by}` | 引用别人的话 |

（`title` 和 `hero` 的差别是字号和有无水印；`split`/`splitflip` 同一套样式，只差 `order`。）

## 三种底色

| skin | 观感 | 什么时候用 |
| --- | --- | --- |
| `dark` | 近黑底 + 主题色光晕 | 默认 |
| `cream` | 米白底 + 深色字 + 橙色光晕 | `state.n % 4 === 2` |
| `wash` | 满版 accent 色，深色字 | `stat`/`stats`/`quote`；或 `state.n % 7 === 5` |

`noInvert: true` 可以强制深色（占位页用，避免边说边出时底色乱闪）。

HUD（字幕条、输入栏、页码）会跟着底色变深变浅，规则在 `stage.css` 末尾的 `body[data-skin]` 段。

## 选择流程（`derive()`）

```
1. 按内容形状映射
   bullets|cards + points(2–4, ≤15字)        → cards
   bullets|cards + points(≥2, ≤8字)          → chips
   bullets|cards + points(长)                → bullets
   bullets|cards + 没有 points               → hero
   stat + 多个数字                            → stats
   title + 有副标题                           → split / band（按 n 奇偶）
   title + 无副标题                           → hero / title
   bigidea                                    → hero

2. 防重复
   和上一页同构图 → 换同族里的另一个
   hero→band  band→split  split→splitflip  splitflip→hero
   cards→chips  chips→cards  bullets→steps  steps→bullets  quote→hero

3. 连续三页都是"一句话"（hero/title/band）
   有 points → cards/chips
   有 steps  → steps
   有对照    → compare

4. 有副标题的 hero/title → 按 n%3 在 split / band / hero 之间轮换

5. 本地正则：标题匹配 /从(.{2,12}?)到(.{2,12})/ → compare

6. 底色（见上表）

7. 图形：hero/band/split/splitflip 没指定 art 时按关键词挑
```

`RECENT` 只保留最近三页的构图。`settle=true` 表示"就地改写当前页"，此时比较的对象是**上上页**，因为它替换的是 `RECENT` 的最后一个位置。

## 图形符号

十二个内联 SVG，没有外部资源、没有网络请求：`spark`（星芒，默认）、`bolt`、`clock`、`chart`、`users`、`chip`、`layers`、`wave`、`bulb`、`target`、`grid`、`arrow`。

匹配规则是**双字词组**而不是单字（单字会误命中，比如"三件事"里的"实"曾经命中闪电）：

| 关键词 | 符号 |
| --- | --- |
| 幻灯片 / 演示 / 版面 / 页面 / 版式 / PPT / 讲稿 | `layers` |
| 模型 / 智能 / 算法 / 芯片 / AI / 大模型 | `chip` |
| 实时 / 延迟 / 秒 / 速度 / 更快 / 瞬间 | `bolt` |
| 小时 / 分钟 / 周期 / 耗时 | `clock` |
| 增长 / 一倍 / 效率 / 数据 / 提升 | `chart` |
| 用户 / 团队 / 大家 / 观众 / 听众 | `users` |
| 声音 / 口播 / 语音 / 说话 / 开口 / 听 | `wave` |
| 想法 / 创意 / 灵感 / 点子 | `bulb` |
| 关键 / 核心 / 本质 / 重点 / 难点 | `target` |
| 工具 / 流程 / 系统 / 管线 / 步骤 | `grid` |

`pickGlyph(...texts)` 按顺序试，命中第一个就返回。

## 预览

任何一个版式都能单独看，不进语音管线：

```
http://127.0.0.1:4400/?preview=hero&clean=1
```

`preview` 可选：`hero` `title` `band` `split` `splitflip` `cards` `chips` `bullets` `steps` `stat` `stats` `compare` `quote` `invert`（米白）`wash`（满版色）。

`clean=1` 会隐藏 HUD，方便截图。改版式时这个组合最快：改一行 CSS → 刷新 → 看一眼。

## 加一种新版式

以 `timeline` 为例，五步：

1. **`stage.css`**：写 `.l-timeline { ... }`，用现成的设计令牌（`--ink`、`--dim`、`--line`、`--accent`、`--pad`），动画类用 `clip` / `anim` / `rise`，`--d` 控制逐条延迟。
2. **`stage.js` 的 `layoutHTML()`**：加一个 `case 'timeline'`，返回 HTML 字符串。文字一律走 `esc()`，需要图形用 `svgIcon(name)`。
3. **`derive()`**：决定什么时候选它。优先放在"按内容形状映射"那一段，不要放在防重复逻辑里。
4. **`SAMPLE`**：`?preview=timeline` 要有样例数据，否则没法单独看。
5. **`director.mjs`**：只有当模型需要**新字段**时才改提示词。如果只是重新排布已有字段（比如把 `steps` 画成横向时间线），提示词一个字都不用动。

## 设计上的几条硬约束

- **一屏最多 3 行字**。多了就看不清，模型侧和渲染侧都做了截断。
- **字号只有几档**：136 / 78 / 66 / 58 / 46 / 40 / 30 / 25。不要临时插值，否则整场看下来会很吵。
- **动画只允许两种**：`clip`（从下往上揭）和 `rise`（淡入上浮）。逐条 `--d` 错开 60–100ms。
- **每页只能有一个"最大声"的元素**：要么是大字，要么是色块，要么是数字。两个同时抢，页面就散了。
