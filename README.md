# multi-cc-im

个人本地 bridge：通过腾讯 iLink Bot API 把跑在 **WezTerm tab 里的多个 Claude Code session** 暴露到微信，实现"在公司用控制台 + 外面用微信"双客户端 + `@session` 路由 + cc 用量分析 + 多 IM/term/CLI 可扩展。

## 文档入口

| 文件 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **必读硬约束**：核心约束 / DD 流程 / 关键规范 / 编码行为准则 / 禁止清单 |
| [docs/architecture.md](docs/architecture.md) | 架构图 / 包依赖 / 数据存储 / 外部 CLI 路径策略 |
| [docs/dev.md](docs/dev.md) | 开发命令 + TDD 节奏 |
| [docs/competitors.md](docs/competitors.md) | 不直接采用的端到端项目（决策记录）|
| [docs/superpowers/specs/](docs/superpowers/specs/) | DD 报告（iLink 选型 / hook+wezterm 实测 / adapter 接口 / Storage 策略）|

## 开发命令

```bash
pnpm install
pnpm typecheck     # tsc -b --noEmit
pnpm test          # vitest run
pnpm test:coverage # vitest run --coverage（≥80% 覆盖率门槛）
```

## License

MIT
