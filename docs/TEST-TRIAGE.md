# 测试处置建议

本轮仅分类，不删除、不合并任何测试。完整测试标题及所属文件见 [`TEST-MAP.md`](TEST-MAP.md)。npm 测试由 Node.js test runner 执行，来源为 24 个 `tests/*.test.cjs` 文件；循环/参数化用例在运行时会展开，和静态源码声明数不是同一口径。

## 分类原则

- **P0 核心不变量**：错误时可能误播放、误完成、跳过课程、错误导航、越过暂停/重置或误绑定课程。必须保留；改动前后都应运行。
- **P1 关键流程**：正常开始、扫描、目录、播放、平台确认、刷新接管和跨课收尾。保留，必要时在稳定性修复中拆慢用例。
- **P2 回归防线**：具体 race/异常边界测试。看似相近，但每个覆盖不同消息顺序、身份或证据；只有建立覆盖矩阵后才讨论合并。
- **P3 可维护性候选**：仅测实现细节、重复验证完全同一条件或极低价值 DOM 展示细节。先列候选，保留可追溯来源；不能只因测试较长/难懂就删除。
- **E 环境/时间敏感**：依赖 fake timer、消息延迟、定时器推进或浏览器 fixture。关注超时；超时不等于测试无效。
- **B 浏览器/真实平台边界**：合成测试无法完整证明。需 fixture 或隔离浏览器手工/自动化验收，不应声称由 npm test 覆盖。

## 文件级处置矩阵

| 文件 | 重点分类 | 初步建议 |
|---|---|---|
| `agent-entry.test.cjs` | P1/P2/E | 保留。入口点击、同页切换、目标唯一性和取消顺序不同，不能仅按“都测课表入口”合并。 |
| `background-interruption.test.cjs` | P0/P2 | 保留。旧文档/新文档接管和预算递增是不同授权条件。 |
| `background-target.test.cjs` | P0/P1 | 保留。完成证据、单遍模式、重试预算和刷新检查点属于持久化契约。 |
| `background.test.cjs` | P0/P1/P2 | 全量保留。文件大但集中验证后台状态机与身份/暂停竞态；后续可按领域拆文件，不删断言。 |
| `floating-assistant-ui.test.cjs` | P1/P2/B | 保留。UI 和任务解耦、拖动、视口、SVG hit testing、MV3 资源声明；不应混入业务重构。 |
| `gateway.test.cjs` | P0/P2/E | 保留。请求/暂停/弹窗时序与站点证据关联决定是否自动操作。 |
| `home-recovery.test.cjs` | P1/P2/E | 保留。分页变化和暂停时序不是重复场景。 |
| `home.test.cjs` | P1 | 保留。课程候选过滤、分页、身份重复和端到端顺序。 |
| `interruption-integration.test.cjs` | P0/P1/P2/E/B | 保留并单独监控。跨 content/background 的高价值行为；长集成场景应留意观察超时和环境负载。 |
| `interruption-reload-background.test.cjs` | P0/P2/E | 保留。精确 URL、刷新预算和取消发生于保存窗口的边界。 |
| `log-ui.test.cjs` | P2/P3 | 暂保留。可将像素/滚动细节评为候选，但日志身份、锚点、未读计数和竞态不应删除。 |
| `media-loading.test.cjs` | P0/P2/E | 保留。晚到自动播放及 generation 授权直接关系安全性。 |
| `media.test.cjs` | P0/P1/P2/B | 保留。包含 Beeline 目录根因回归、状态证据区分、媒体点击边界和播放选择。 |
| `playback-target-content.test.cjs` | P0/P1 | 保留。80%–100% 目标与单遍完成语义，不等同 UI 输入测试。 |
| `playback-target-ui.test.cjs` | P1/P2 | 保留。存储跨页面竞态和 UI 设置输入/同步。纯文案测试可后评为 P3。 |
| `public-recovery-integration.test.cjs` | P1/B/E | 保留为公开工作流 smoke；单个测试覆盖长流程，失败定位成本高，可考虑拆解但保留端到端哨兵。 |
| `recovery-background.test.cjs` | P0/P1/P2/E | 保留。后台预算、退避、导航、停止优先级与统计页清理等持久行为。 |
| `recovery-content.test.cjs` | P0/P1/P2/E | 保留。播放位置证据、前跳缺口、人工停止和播放器重建。 |
| `recovery-integration.test.cjs` | P0/P1/E | 保留并监控。长场景端到端恢复；应留意观察超时和环境负载。 |
| `refresh.test.cjs` | P0/P1/P2/E | 保留。目录缓存身份、迟到媒体、hello、route mismatch、断点和暂停竞态。 |
| `reload-failure-integration.test.cjs` | P0/P1/E | 保留。重试耗尽和暂停打断，行为与单元预算测试不同。 |
| `reset-integration.test.cjs` | P0 | 必须保留。验证确认重置、旧消息隔离和重新开始。 |
| `sitewide-start-background.test.cjs` | P0/P1/P2 | 保留。跨页面开始导航与停止/继续竞态。 |
| `sitewide-start-content.test.cjs` | P1 | 保留。验证 UI 发起的站点内开始流程与范围。 |

## 可审查但暂不执行的候选

1. `log-ui.test.cjs` 中纯 UI 几何/滚动阈值用例：如果多例证明完全同一条锚点规则，可合并为表驱动测试；但日志去重、未读数和异步后台快照属于独立不变量。
2. `playback-target-ui.test.cjs` 中默认值、非法值归一化和输入渲染：可评估是否重复覆盖 `playback-target-content.test.cjs`，但跨标签 storage event 与延迟写入顺序不可合并成普通 clamp 测试。
3. `background.test.cjs` / `refresh.test.cjs` 的 query 参数排列用例：要区分“独立 key 排列可容忍”与“原始值、重复 key、编码 key 必须严格相同”；只有审查完整真值表后才可以减少案例。
4. 长集成场景：可以抽共享 fixture/helper 或将场景拆成较小阶段，但需保留至少一条端到端闭环测试。缩短运行时间不是删除故障路径断言的理由。
5. 纯源码禁止性断言（例如不得调用媒体播放 API）：这是关键安全约束，虽然实现级，但不是无价值测试。

## 当前优先级与建议顺序

1. 先稳定完整测试运行与超时原因记录；保留原始输出和单独重跑结果。
2. 为目录识别维护脱敏 fixture：Beeline `.section-content`、旧式 `li.el-menu-item`、隐藏响应式副本、折叠章节、空目录和晚到叶项。
3. 为各文件维护“不变量 -> 代表测试 -> 失败风险”覆盖矩阵。
4. 只有某个测试没有独立不变量、已由另一测试可靠覆盖且变异/故障注入仍能检出时，才提议合并/删除，并单独提交。

## 已知测试边界

- `npm test` 是模拟环境测试。它不能证明真实登录、网站完成记录持久化、浏览器睡眠、自动播放策略、验证码处理或所有页面模板兼容。
- 历史验证文档记有偶发的长集成观察超时，也记录后续完整复跑通过；不应把历史超时抹掉，也不应把一次超时直接判为业务 bug。
- Playwright UI smoke 是独立可选脚本，不在 `npm test` glob 中；它加载本地 fixture，不启动课程任务。
