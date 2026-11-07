# Issue 清单

2026-11-07 已发布：总任务 [#21](https://github.com/wwq0327/live-deck/issues/21)，第一阶段 S01—S10，后续 S11/S12。以下均为待开发任务，不代表完成。

从 [S01 #22](https://github.com/wwq0327/live-deck/issues/22) 开始，按依赖推进。文档正文与任务存档已经随本目录保存。

| 代码 | 任务正文 | 依赖 | 阶段 | GitHub |
| --- | --- | --- | --- | --- |
| S00 | [总任务](S00.md) | 第一阶段全部 | 总任务 | [#21](https://github.com/wwq0327/live-deck/issues/21) |
| S01 | [建立可修正的语义图协议、来源校验与原子 Store](S01.md) | 无 | 基础 | [#22](https://github.com/wwq0327/live-deck/issues/22) |
| S02 | [建立版本化转写账本，正确处理 partial 替换与 final 顺序](S02.md) | 无 | 基础 | [#23](https://github.com/wwq0327/live-deck/issues/23) |
| S03 | [建立只开放已到达信息的增量回放与语义验收夹具](S03.md) | [S01 #22](https://github.com/wwq0327/live-deck/issues/22)、[S02 #23](https://github.com/wwq0327/live-deck/issues/23) | 基础 | [#24](https://github.com/wwq0327/live-deck/issues/24) |
| S04 | [新增有证据的 Flash 语义导演与 /api/understand](S04.md) | [S01 #22](https://github.com/wwq0327/live-deck/issues/22)、[S03 #24](https://github.com/wwq0327/live-deck/issues/24) | 理解 | [#25](https://github.com/wwq0327/live-deck/issues/25) |
| S05 | [实现持续语义调度、完整消费与版本冲突重算](S05.md) | [S01 #22](https://github.com/wwq0327/live-deck/issues/22)、[S02 #23](https://github.com/wwq0327/live-deck/issues/23)、[S04 #25](https://github.com/wwq0327/live-deck/issues/25) | 理解 | [#26](https://github.com/wwq0327/live-deck/issues/26) |
| S06 | [建立按稳定对象 ID 更新的 DOM/SVG 渲染与局部动画](S06.md) | [S01 #22](https://github.com/wwq0327/live-deck/issues/22) | 画面 | [#27](https://github.com/wwq0327/live-deck/issues/27) |
| S07 | [实现因果、对比、组成、汇聚四类关系场景与统一主题](S07.md) | [S06 #27](https://github.com/wwq0327/live-deck/issues/27) | 画面 | [#28](https://github.com/wwq0327/live-deck/issues/28) |
| S08 | [将真实语音接入持续理解模式，隔离旧逐句出页链路](S08.md) | [S02 #23](https://github.com/wwq0327/live-deck/issues/23)、[S05 #26](https://github.com/wwq0327/live-deck/issues/26)、[S07 #28](https://github.com/wwq0327/live-deck/issues/28) | 联调 | [#29](https://github.com/wwq0327/live-deck/issues/29) |
| S09 | [增加保持恢复、有限历史修正与独立人工纠正通道](S09.md) | [S08 #29](https://github.com/wwq0327/live-deck/issues/29) | 配合 | [#30](https://github.com/wwq0327/live-deck/issues/30) |
| S10 | [完成真实 Flash 语义质量、实时语音与视觉验收报告](S10.md) | [S03 #24](https://github.com/wwq0327/live-deck/issues/24)、[S04 #25](https://github.com/wwq0327/live-deck/issues/25)、[S05 #26](https://github.com/wwq0327/live-deck/issues/26)、[S06 #27](https://github.com/wwq0327/live-deck/issues/27)、[S07 #28](https://github.com/wwq0327/live-deck/issues/28)、[S08 #29](https://github.com/wwq0327/live-deck/issues/29)、[S09 #30](https://github.com/wwq0327/live-deck/issues/30) | 第一阶段验收 | [#31](https://github.com/wwq0327/live-deck/issues/31) |
| S11 | [支持多人观点归属、分歧与可靠说话人输入](S11.md) | [S10 #31](https://github.com/wwq0327/live-deck/issues/31) | 后续 | [#32](https://github.com/wwq0327/live-deck/issues/32) |
| S12 | [增加图片标注、素材复用与异步配图隔离](S12.md) | [S10 #31](https://github.com/wwq0327/live-deck/issues/31) | 后续 | [#33](https://github.com/wwq0327/live-deck/issues/33) |

每项 GitHub 正文都包含目标、依赖、开发入口、工作范围、验收和排除项。协议与验收不能被实现时的临时约定替代。旧 #8/#13 保留原范围，没有在本轮关闭。

开发流程见 [HANDOFF.md](../HANDOFF.md)。各 Issue 的方案链接固定到文档提交，避免后续分支变化丢失依据；更新协议时应同时更新关联任务。
