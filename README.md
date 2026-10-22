# Xinwei Course Watcher

这是一个面向 [Beeline AI](https://www.beeline-ai.com/) 学习页面的 Chrome/Edge Manifest V3 扩展。本目录是向 `WuXinbo-bo/xinwei-watcher` 提交的 **1.1.0 候选贡献版本**，基线为 `c92a3428b7fde0ebd47425a609dd7b5656b1822d`。

本版本保留原作者项目的署名和 Apache License 2.0。它不是原作者已经发布或认可的版本；是否合并由原作者审核决定。

## 功能

- 扫描正在上的课程，识别课程目录中的视频、音频和部分其他条目。
- 按剩余音视频数量选择课程，并在课程内按原有短时长优先规则处理媒体。
- 支持 **80%–100% 播放目标**，默认目标为 100%；目标设置会持久化，并同步到已打开的课程页面。
- 达到目标后切换到下一项；课程首轮处理结束后刷新页面，核对平台延迟更新的完成状态。
- 对播放、页面加载、目录更新和误触导航提供有界恢复；失败会保留具体课程、章节和资源记录。
- 支持暂停、继续、重置、任务状态持久化、断点恢复和有界日志。
- 不处理文档、考试和作业，不绕过登录、验证码或平台限制。

## 安装

1. 下载或克隆本仓库，并解压到一个固定目录。
2. 打开 `edge://extensions/` 或 `chrome://extensions/`。
3. 开启开发者模式，选择“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的项目根目录。
5. 打开或刷新 Beeline AI 学习页面。

更完整的安装、升级和使用说明见 [`README-INSTALL.md`](README-INSTALL.md)。运行时不需要安装 Node.js；Node.js 仅用于开发检查和测试。

## 使用方法

1. 登录 Beeline AI 并进入课程页面。
2. 等待课程目录和播放器加载完成。
3. 点击面板中的“开始”，确认扫描到的课程和未完成数量合理。
4. 将播放目标设为 80%–100% 之间的值；默认值为 100%。首次建议只处理一个条目并观察一次切换。
5. 需要停下任务时使用扩展面板的“暂停”。登录失效、验证码、题目、平台限制或关键保存失败需要人工处理。

播放目标只决定扩展何时转到下一项，不等同于平台已经确认整门课程完成。课程末复核和异常资源重试仍受网站响应、登录状态和页面结构影响。

## 开发与测试

在项目根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` 检查运行脚本语法；`npm test` 使用 Node.js 测试运行器和 jsdom 执行合成页面测试。合成测试不能替代真实浏览器、平台进度记录、自动播放权限或登录状态验证。测试范围和本次运行结果见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

## 许可证与贡献

项目保留原作者的 Apache License 2.0 和署名。提交上游前请阅读 [`UPSTREAM_REVIEW.md`](UPSTREAM_REVIEW.md) 和 [`GITHUB_SUBMISSION.md`](GITHUB_SUBMISSION.md)，并在自己的分支上运行完整检查。不要上传 `.git`、`node_modules`、浏览器资料、账号信息、Cookie、Token、密钥或内部证据。
