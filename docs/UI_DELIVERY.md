# 悬浮助手 UI 交付

## 范围

本轮只修改候选版 UI 外壳。与 Fork 业务分支 `96822b0` 相比，`background.js`、播放及任务恢复算法、依赖版本和浏览器权限保持不变；版本仍为 `1.1.0`。原面板内容、元素 ID 和按钮处理器保持现有结构。

默认显示用户提供的本地图片悬浮球；使用指针事件、6px 拖动阈值和可视视口约束，点击展开完整面板。收起只隐藏界面，不停止任务或日志。

## 动态文字

比较过两种轻量实现：

- CSS Motion Path：适合整段短语沿路径移动，但短语不会逐字沿圆角弯曲，不能满足本次确认效果。
- SVG `textPath`：同一条闭合圆角矩形路径，字形切线方向由浏览器排版；用 SVG `animate` 更新 `startOffset`，无需 JavaScript 每帧读写布局。

最终采用 SVG。路径在原面板外 16px；同一闭合圆角矩形轨迹首尾相接定义两圈，第二圈作为文字越过循环接缝时的缓冲路径。DOM 文字只渲染一份：品牌、标语和两项服务各出现一次，单条文案沿圆角矩形完整绕行，剩余轨道留空，循环接缝处不跳跃或消失。约 20 CSS px/s，悬停当前短语由 11px 放大到 13px并暂停。只有点中文字才通过原生链接打开配置网址。外围 SVG 画布不接管空白区域点击；独立商业服务身份保留在可访问名称和链接语义中。

点击后、页面返回、可见性恢复及 BFCache 返回时清理遗留焦点。鼠标需要累计移动超过 2px 才重新启用悬停暂停，避免浏览器恢复时的静止光标再次锁住轨道。系统减少动态效果时静止；窄/矮视口采用面板下方单行外链。

在 `content.js` 的 `PROMOTION_CONFIG` 集中配置；设 `enabled: false` 可移除推广层，不依赖课程任务状态。

## 修改文件

相对 Fork `feature/playback-target-completion` 的 UI 交付：

- `content.js`：悬浮入口、视口约束、原面板外层、可禁用 SVG 文字轨道。
- `manifest.json`：仅开放本地悬浮图片给既有课程来源。
- `assets/floating-assistant.png`：用户提供的 1254×1254 PNG，未生成新角色。
- `tests/floating-assistant-ui.test.cjs`：新增 UI 回归用例。
- `tests/agent-entry.test.cjs`、`tests/sitewide-start-content.test.cjs`：适配默认收起。
- `tests/ui-browser-smoke.cjs`：可选隔离浏览器验收，不加入日常依赖。
- `README.md`、`README-INSTALL.md`、`CHANGELOG.md`、`tests/README.md`、`docs/VERIFICATION.md`、`GITHUB_SUBMISSION.md` 和本文件：使用、验证和交付说明。

## 验证和限制

- `npm ci --ignore-scripts` 成功；现有依赖有 `whatwg-encoding` 弃用警告。
- `npm run check` 通过；386 项合成测试通过。UI 专项覆盖默认收起、展开/收起、拖动、任务不受影响、视口、返回恢复、减少动画及配置关闭。
- 隔离 Microsoft Edge `155.0.4283.62` 实际加载扩展，本地 fixture 上的 SVG 排版、主动点击、动画恢复、本地图片、窄屏与减少动画均通过。
- 用户现有 Edge 已重新加载当前扩展，在真实课表页确认拖动与点击区分、展开/收起、圆角文字转向、实际文字链接跳转及返回后继续移动。原目录控件可操作，未启动或重置课程任务；当前窗口未单独验证悬停，相关行为由隔离浏览器测试覆盖。
- 有一次并行浏览器/完整套件高负载运行出现既有网关用例超时，关闭隔离浏览器后完整复跑通过；未修改业务测试等待时间。
- 仍有既有的可选日志测试诊断 `location is not defined`，不影响测试退出状态。
- 未承诺锁屏、浏览器休眠、旧版 Chromium、所有字体和平台缩放组合均验证。常规系统睡眠时动画暂停属于正常行为；唤醒后页面可见性事件恢复。
- 本次未启动真实课程播放，浏览器截图是实际扩展在本地 fixture 上的渲染，不是课程完成证据。

## Git 与发布

可推送分支：`feature/ui-floating-assistant-orbit`，继承 Fork 业务分支及上游 `main` 历史。保留原 `work/ui-floating-assistant-promotion`，没有删除 `.git`、强推、Tag 或 Release。

按用户最后决定，GitHub 推送和 PR 由用户自行操作，本轮不再代为提交远程更改。

建议总体提交信息：`feat: add floating assistant and optional SVG edge promotion`。

上游尚未合并此前的候选业务分支，因此与上游 `main` 的 PR 会同时包含此前业务贡献；本轮 UI 不应被描述为上游全部差异。PR 文案见 `GITHUB_SUBMISSION.md`。
