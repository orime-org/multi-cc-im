# 开发命令

> v0 设计阶段尚无业务代码。本文是规划版命令清单，待 monorepo 初始化时实施。

```bash
pnpm install               # 装依赖
pnpm dev                   # turbo 启所有包 watch
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm build                 # tsup 编译所有 package 到 dist/
pnpm bridge:start          # 启动 bridge 主进程
pnpm bridge:hook-install   # 把 SessionStart/Stop/... 写入 ~/.claude/settings.json
pnpm bridge:wechat-login   # 扫码登录 iLink，存 bot_token 到 OS keychain
pnpm bridge:cli-resolve    # 探测并写入外部 CLI 路径（wezterm 等）到 config.toml
```

## 启动前置

1. macOS（v1 仅支持 macOS）
2. wezterm 已安装（可选路径见 `docs/architecture.md` 「外部 CLI 工具路径策略」节）
3. claude（cc）已登录
4. iLink bot 已申请（`pnpm bridge:wechat-login` 引导）
