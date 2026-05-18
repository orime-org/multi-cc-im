# 应有文档清单

| 路径 | 用途 | 什么时候改 |
|---|---|---|
| README.md | 用户入口 + Quick Start + Two-audience 分流 (Part 1 用户 / Part 2 二次开发) | 主功能 / Quick Start 变 |
| README.zh-CN.md | 中文 README，跟英文同步 | 同 README.md |
| CLAUDE.md | AI 干活纪律（头号原则 / 核心约束 / DD 流程 / 编码准则） | 用户拍板纪律变（改前 ask） |
| docs/conventions.md | **状态总表 + 修订日志 + 项目特定规范 + 禁止清单 + 参考资料** | 任何 milestone 必加 entry |
| docs/architecture.md | v0.1.x 架构图 + 4 维 adapter + 数据流 + schema | 架构/protocol 改 |
| docs/dev.md | 本地 dev 命令 + TDD 节奏 + 调试 | dev workflow 变 |
| docs/setup-feishu.md | 飞书 app 创建 + credential 配置 step-by-step | Lark 协议侧变 |
| docs/competitors.md | 同类产品调研 | 竞品出新版 |
| docs/superpowers/specs/*-dd.md | DD 报告（每个重大决策一份） | 新 DD / DD 修订 |
| LICENSE | MIT 标准模板 | 永不变 |

# 缺失文档（推断该有 / 待补）
- **CHANGELOG.md** — 目前靠 conventions.md 修订日志 + GitHub releases，无独立 CHANGELOG（如发布 npm 需补）
- **README.dev.md** 单独的二次开发 onboarding — 当前 README.md Part 2 已覆盖，暂不需

# 跨文档同步规则

| 改了什么 | 同步到哪 |
|---|---|
| IM / Term / CLI / Storage adapter 行为 | conventions.md 状态总表 + architecture.md adapter 节 |
| 加 / 修订 DD | `superpowers/specs/<date>-<topic>-dd.md` + conventions.md 修订日志引一笔 |
| cc hook 行为 | CLAUDE.md「核心约束」+ conventions.md「项目特定技术规范」 |
| 任何 patch-level fix | conventions.md 修订日志加 entry（包含 PR # / 验证步骤） |
