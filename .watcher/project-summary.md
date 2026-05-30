# 项目目的
`multi-cc-im` 是个人本地 bridge：通过飞书 (Lark) IM 把跑在 WezTerm / iTerm2 tab 里的多个 Claude Code session 暴露到手机端，实现「公司用控制台 + 外面用 IM」双客户端 + `#<session>` 路由 + cc 用量分析 + 4 维 (IM/Term/CLI/Storage) adapter 可扩展。

# 主要产出
TypeScript pnpm monorepo (apps/multi-cc-im + 8 workspace packages) + DD 报告 (`docs/superpowers/specs/*-dd.md`) + 修订日志 (`docs/conventions.md`)。

# 项目阶段
**v0.2.x alpha personal-tool** — 单人 use case 真账号验证迭代中。开源 MIT，已发布 npm（`multi-cc-im` package，当前 latest = `0.2.3`，2026-05-30 publish — cc 回复改 CardKit 单卡根治飞书多消息顺序乱 + markdown 原生渲染不限 3 表 + README 四部分重组；前序 0.2.2 含 codex CLI 适配 + 4 步启动向导 + 双 CLI 共存 + 飞书 post 类型支持）。

# 关键约束 / 红线
- TypeScript strict 禁 `any` / ESM only / 凭据 0600 落 JSON 不进 git
- 重大决策必走 5 步 DD（候选含「不做 X」/ 尽调 / 矩阵 / 推荐 / 拍板）
- CLAUDE.md ≤ 200 行；改前**必先用户同意**
- commit / PR / issue 一律不带 AI attribution
- 解决问题必找根因，禁止补丁（症状治疗 PR 当场撤回）
- 改 `~/.claude/*` 等 user dotfile 前必 backup
