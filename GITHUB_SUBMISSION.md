# 上游提交说明

本地整理目标：向 `WuXinbo-bo/xinwei-watcher` 的 `main` 提交 `1.1.0` 候选功能贡献。

- Fork：`scxai-top/xinwei-watcher`
- 开发分支：`feature/playback-target-completion`
- 目标分支：`WuXinbo-bo/xinwei-watcher:main`
- 基线：`c92a3428b7fde0ebd47425a609dd7b5656b1822d`
- 建议提交信息：`feat: add configurable playback targets and course completion checks`
- 建议 PR 标题：`支持自定义播放目标与课程完成状态核对`

## 本地提交前

从本目录根部提交全部公开源码，保持 `.gitignore`、`docs/`、`tests/` 和 `LICENSE` 的位置不变。不要把 ZIP 文件本身作为仓库内唯一文件，也不要多套一层版本号目录。

在提交前执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

只上传源码和公开文档。不要上传 `.git`、`node_modules`、浏览器资料、账号信息、Cookie、Token、密钥、内部证据或本机绝对路径。先在自己的 Fork 分支检查差异，再创建指向原作者 `main` 的 Pull Request。本次本地整理没有 Push、创建 PR、Merge 或创建 Release。

## PR 描述

```markdown
### Summary

- 支持保存 80%–100% 的播放目标，默认目标为 100%。
- 增加课程完成状态核对，并处理平台延迟更新。
- 为异常资源增加有界重试和失败记录。
- 保留暂停、恢复、任务持久化、首页扫描、课程选择、日志和错误处理。

### Validation

- `npm run check`：通过，退出码 0；`content.js` 和 `background.js` 语法检查通过。
- `npm test`：通过，366/366 项通过，0 失败、0 取消、0 跳过；耗时约 70.1 秒。
- `npm ci --ignore-scripts`：成功安装 39 个包；仅有一条依赖弃用警告，详见 `docs/VERIFICATION.md`。
- 此前 Edge 观察曾确认一次 80% 目标达到后平台计数增加并进入下一项；这不是整门课程的真实验收。

### Notes

完整课程和所有恢复场景尚未全部进行真实环境验证，请重点审阅课程末核对、异常资源重试、跨页面恢复和新增权限。
```
