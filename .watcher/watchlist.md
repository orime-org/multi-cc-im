# 用户自定义关注点

watcher 每次跑都纳入考虑：

## 纪律层
- commit / PR / issue 不带 `Co-Authored-By` 或 `Generated with Claude Code`
- TypeScript strict，禁 `any`（用 `unknown` + zod 替代）
- 凭据敏感字段 (`app_id` / `app_secret` / OAuth token) 不进 git / 日志 / console / toml
- CLAUDE.md 行数 ≤ 200，改前必先用户同意
- `docs/conventions.md` 修订日志膨胀到 250+ 行后考虑归档

## 测试层（patch / feature 完成必跑）
- `pnpm typecheck` + `pnpm test` 必过
- 改 CLI / 影响 bundle 时 `pnpm --filter multi-cc-im build` + `./bin/multi-cc-im --version` smoke
- 改 `package.json` 必跑 `pnpm install --frozen-lockfile` 模拟 CI
- 改 daemon spawn cc 行为必带 `--settings '{"disableAllHooks":true}'`（memory `feedback_ai_router_log_first.md`）
- 改 user dotfile (`~/.claude/...`) 必先 `cp` 到 `.bak.<ISO>` 备份

## 文档同步层
- v0.x.y release 后 `docs/conventions.md` 修订日志必加 entry 罗列 PRs + verification
- DD 锁定 / 修订必更新 `docs/conventions.md` 状态总表那一行
- README.md 跟 README.zh-CN.md 内容必同步

## 监控层 (post v0.1.1)
- `daemon.log` 的 `[AI router] target=X intent=Y reason=Z` 三字段是 prod 健康的 ground truth
- 「IM 漏 strip / verbatim 通过」类反馈必先 `grep "[AI router]" ~/.multi-cc-im/daemon.log | tail -5` 看四档（exec stdin / exec hooks / prompt / 渲染）再考虑改 prompt
- 监控 dashboard `http://127.0.0.1:40719` 是 daemon 健康 + cc 成本的本地仪表盘
