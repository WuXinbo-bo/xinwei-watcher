# 合成测试

这些测试使用模拟页面、媒体元素和浏览器消息验证 `content.js` 与 `background.js` 的协作，不连接真实学习网站，也不代表平台完成记录已经写入。

## 运行

在项目根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` 检查运行脚本语法；`npm test` 使用 Node.js 测试运行器和 jsdom。测试通过不能替代真实浏览器回归、权限验证、登录状态、自动播放设置、网站结构变化或睡眠场景。

## 覆盖范围

- 站内页面回到已确认首页、课表扫描和同一任务接管。
- 按剩余音视频数量选择课程及课程内媒体排序。
- 区分资源识别、打开、播放、自然结束和网站完成标记。
- 目标设置、目标持久化、暂停/继续、刷新和跨文档任务恢复。
- 课程卡片抽屉在扫描中隐藏、完整扫描后展开；手动收起在进度更新时保留，开合不发送任务指令。
- 播放、目录、导航、刷新和浏览器操作故障的有界恢复。
- 课程末平台核对、异常资源重试、日志保留和人工阻断场景。

本文件描述测试设计；本轮 UI 的实际结果见 [`docs/UI_DELIVERY.md`](../docs/UI_DELIVERY.md)，历史业务验证见 [`docs/VERIFICATION.md`](../docs/VERIFICATION.md)。

## 可选浏览器 UI 验收

1.3.0 首页卡片与单课流程见 [ON_DEMAND.md](../docs/ON_DEMAND.md)。on-demand.test.cjs 验证所选课程授权、扫描后播放、暂停转交竞态和刷新边界；public-recovery-integration.test.cjs 通过首页卡片一键开始，验证完整扫描后学习以及课末停下；home.test.cjs 中的旧调度器全流程仅保留为旧协议回归。

`ui-browser-smoke.cjs` 不包含在 `npm test` 中。它使用测试环境提供的 Playwright，在独立临时配置中实际加载扩展，以本地 fixture 拦截页面与外链，不访问课程数据或启动课程任务。项目运行依赖与锁文件不因此增加 Playwright。

在已提供 Playwright 的环境执行，可通过 `NODE_PATH` 指向该测试工具目录：

```sh
BROWSER_EXECUTABLE="/path/to/Edge" UI_ARTIFACTS_DIR="/tmp/xinwei-ui-results" \
  node tests/ui-browser-smoke.cjs
```

验收项包括扩展本地图片、默认收起、品牌齿轮、无开关的赞助轮播与图标扫光、悬停暂停、首页课程卡片/本课学习项、长标题与按钮几何尺寸、运行锁定与暂停继续、全部内页、19 类任务状态及全部完成/空结果、设置保存、重置取消、拖动与键盘展开、窄/矮视口、深色模式和减少动态效果。测试只在本地合成文档内设置显示状态，不点击开始或确认重置。截图为本地 fixture 上的真实浏览器渲染，不代表真实课程验收。
