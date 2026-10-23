# 上游提交说明

本地整理目标：向 `WuXinbo-bo/xinwei-watcher` 的 `main` 提交 `1.1.0` 候选功能贡献。

- Fork：`scxai-top/xinwei-watcher`
- 开发分支：`feature/ui-floating-assistant-orbit`，基于 Fork 既有的 `feature/playback-target-completion`
- 目标分支：`WuXinbo-bo/xinwei-watcher:main`
- 基线：`c92a3428b7fde0ebd47425a609dd7b5656b1822d`
- 建议提交信息：`feat: add floating assistant and optional SVG edge promotion`
- 建议 PR 标题：`1.1.0 candidate: 播放目标、课程核对与悬浮助手 UI`
- 最终代码修正提交：`ec6b208`（单份推广文案完整绕行，不重复铺满轨道）

## 推送到自己的 Fork

当前源码已经保存在本地 Git 分支中，无需重新初始化仓库或重复提交。确认位于本项目根目录后执行：

```sh
git status --short --branch
git remote -v
git push -u origin feature/ui-floating-assistant-orbit
```

`origin` 应指向 `https://github.com/scxai-top/xinwei-watcher.git`。不要强制推送，不要覆盖 `main` 或既有的 `feature/playback-target-completion` 分支。

推送成功后在 GitHub 创建 Pull Request，选择：

- Base repository：`WuXinbo-bo/xinwei-watcher`
- Base branch：`main`
- Head repository：`scxai-top/xinwei-watcher`
- Compare branch：`feature/ui-floating-assistant-orbit`

PR 标题使用上方建议标题，正文使用下方 `PR 描述` 中的 Markdown 内容，不包含代码围栏本身。助手没有代为推送、创建 PR、Tag 或 Release。

## 上传范围

上传项目根部的全部公开源码，保持 `.gitignore`、`docs/`、`tests/`、`assets/` 和 `LICENSE` 的位置不变。源码 ZIP 是完整源码备份，不要把 ZIP 文件本身作为仓库内唯一文件，也不要多套一层版本号目录。

需要重新验证时，在项目根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

只上传源码和公开文档。不要上传 `.git`、`node_modules`、浏览器资料、账号信息、Cookie、Token、密钥、内部证据或本机绝对路径。先在自己的 Fork 分支检查差异，再创建指向原作者 `main` 的 Pull Request。

上游 `main` 尚未包含 Fork 的既有业务贡献，因此此分支与上游的完整 PR 差异也包含此前的播放目标及任务恢复代码。本轮 UI 改动相对于 Fork 的 `96822b0` 不修改 `background.js` 或依赖锁文件，版本保持 `1.1.0`。

## PR 描述

```markdown
### Summary

- 支持保存 80%–100% 的播放目标，默认目标为 100%。
- 增加课程完成状态核对，并处理平台延迟更新。
- 为异常资源增加有界重试和失败记录。
- 保留暂停、恢复、任务持久化、首页扫描、课程选择、日志和错误处理。
- 默认收起为本地图片悬浮球，可拖动、点击展开原有完整课程面板。
- 增加独立可关闭的 SVG `textPath` 商业推广轨道。品牌、标语及两项服务各出现一次，组成单条文案沿圆角矩形完整绕行，其余轨道留空，字形随直边与圆角转向。
- 保留文字悬停放大、主动点击外链、返回后恢复动画；小视口与减少动态效果有兜底。没有自动跳转、远程脚本或追踪。

### Validation

- `npm run check`：通过，退出码 0；`content.js` 和 `background.js` 语法检查通过。
- `npm test`：386/386 项通过，0 失败、0 取消、0 跳过。
- `npm ci --ignore-scripts`：成功安装 39 个包；仅有一条依赖弃用警告，详见 `docs/VERIFICATION.md`。
- 隔离 Edge `155.0.4283.62` 加载实际解压扩展，在本地 fixture 上验证图片、单份文案及空白轨道、完整绕行、字形拐角、悬停、链接、返回恢复、窄视口和减少动态效果。未在该测试中启动真实课程任务。
- 在用户现有 Edge 中重载最新解压扩展并刷新真实课表页，确认展开原面板及单份文字移动；没有点击开始或重置。真实课程运行测试留待用户接手，不能视为已通过。
- 此前 Edge 观察曾确认一次 80% 目标达到后平台计数增加并进入下一项；这不是整门课程的真实验收。

### Notes

完整课程和所有恢复场景尚未全部进行真实环境验证，请重点审阅课程末核对、异常资源重试和跨页面恢复。

商业推广是 Fork 自有配置，不代表课程平台或原作者官方服务。`PROMOTION_CONFIG.enabled = false` 可独立关闭，作者可以单独决定是否接受该模块。UI 本轮不新增浏览器权限、远程脚本或追踪系统。
```
