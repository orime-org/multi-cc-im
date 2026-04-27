# 不直接采用的端到端项目（决策记录）

> 本表是**端到端产品**的不采用判断（通过 `gh repo view` 实测仓库 + README 验证）。
> **协议层候选**（photon-hq / openclaw-weixin / weixin_bot_plugin / cc-weixin / from scratch）单独 DD，见 `docs/superpowers/specs/2026-04-26-ilink-library-dd.md`。

| 项目 | ★ | 不采用原因 | 借鉴点 |
|---|---|---|---|
| chenhg5/cc-connect | 6119 | spawn 模式不能托管 WezTerm tab 已有 cc；Go 项目难复用 TS 接口 | adapter 矩阵接口设计参考 |
| Johnixr/claude-code-wechat-channel | 269 | "每 ClawBot 只接 1 agent 实例"（⚠️ 此结论源自 share，README 头我读过未见此明确表述，DD 时再核） | iLink 接入流程参考 |
| sgaofen/cli-in-wechat | 264 | `@` 切**工具种类**而非切多个同种 cc | 跨通道漫游 + `/resume` 设计 |
| Wechat-ggGitHub/wechat-claude-code | 238 | 单 session | 斜杠命令体系完整 |
| six-ddc/ccmux（原 ccbot） | (中) | IM=Telegram + term=tmux + Python | hook+send-keys 架构 + transcript 解析 + tool_use 配对 |
| Bergamolt/telegram-sessions | 4 | Telegram + tmux | 多 session `/new`/`/sessions`/`/kill` + 权限按钮 |
| lc2panda/claude-plugin-wechat | 55 | Channel + ACP，不是 hook 路线 | 全媒体 + 远程权限审批 + 多渠道 UX |
