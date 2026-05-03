# Keychain 库选型 DD 报告

**Topic**: multi-cc-im 把 iLink `bot_token` 落地到 OS keychain（CLAUDE.md「凭据进 keychain」硬规则）选哪个 Node.js 库
**Date**: 2026-05-03
**Status**: 🟡 待用户决定
**结论**: 推荐候选 **C `@napi-rs/keyring`**（理由见第 4 步）；如用户认可，锁定后写入 CLAUDE.md「关键设计假设」+「关键规范」对应栏。

> 本报告按 CLAUDE.md「重大决策 DD 流程」5 步走。触发启发式：「影响项目安全模型」（凭据存储）+「影响长期维护负担」（核心 native binding 部署链）+「跨平台兼容性」（macOS+Linux+Windows+headless WSL）。
>
> Memory 规则「DD 候选枚举必须含'不做 X'」遵守：候选 A 是「不引入 keychain 库 / 直接读 ENV var」。

---

## 决策上下文

PR #8 落地 wechat IMAdapter 骨架时，`createWeixinAdapter({ token })` 的 `token` 是 caller 直接传入的字符串。CLAUDE.md「关键规范」明文要求：

> **禁止硬编码密钥** | 密钥走 keychain
> **凭据进 keychain** | `bot_token` 落盘前必须经 `keytar` / `secret-tool`；明文出现在文件或日志 = bug

注意 CLAUDE.md 写规则时举的两个例子 (`keytar` 和 `secret-tool`) **本身就是技术选型**，但当时没经 DD —— 写规则的人随手举了两个最有名的例子。本 DD 要做的是**正经评估 token 持久化方案**，结论可能继承（用 keytar 系）也可能否定（DD 数据显示 keytar 已 archived 2 年）。

需求清单：
1. 启动时读 `bot_token`，bridge 跑起来
2. 首次扫码登录后写 `bot_token`，重启不丢
3. 跨 macOS（Apple Silicon + Intel）+ Linux（gnu / musl / 含 headless WSL）+ Windows
4. Node.js ≥ 22，ESM only
5. 不能明文落盘（CLAUDE.md 硬规则）
6. 不能让用户首次 `pnpm install` 撞 native binding 编译失败（multi-cc-im 是开源项目，目标用户 ≠ 全栈 C++ 工具链 ready）

---

## 第 1 步：候选枚举

| ID | 候选 | 描述 |
|---|---|---|
| **A** | **不做 keychain 集成** | 文档建议用户外置（1Password CLI / direnv+sops / pass / age），multi-cc-im 只读 ENV var |
| B | `keytar` (atom/node-keytar) | 老牌，CLAUDE.md 现有规则就是举它做例子 |
| B.1 | `@github/keytar` (GitHub fork) | atom 仓库归档后 GitHub 派生维护 |
| **C** | **`@napi-rs/keyring`** (Brooooooklyn/keyring-node) | Rust napi-rs 实现，prebuilt binaries |
| D | spawn 平台 native CLI | macOS `security` / Linux `secret-tool` / Windows `cmdkey` |
| E | 文件加密 + 用户 passphrase | node:crypto AES-256-GCM 或 `age-encryption` 包 |
| F | `keyv` / `node-vault` 类 generic K/V | Generic K/V store + crypto adapter |
| **G.1** | **`@zowe/secrets-for-zowe-sdk`** | Zowe Foundation Rust napi binding，foundation 维护 |
| G.2 | `cross-keychain` (magarcia) | hybrid wrapper：napi-rs/keyring 主 + CLI fallback + 文件加密兜底 |

进 DD 第 2-4 步：**A / C / G.1** 三个真候选 + 透明排除其他。

**透明排除**（不进对比矩阵）:

| 候选 | 排除理由（含可验证证据） |
|---|---|
| **B keytar** | repo `archived: true`（2022-12 atom 整体归档），最后 commit `deae59a` 2022-03-02，最后 npm publish 7.9.0 2022-02-17（**4 年前**）。**没有 Node 22+ prebuilt binaries**，pnpm + Node 22 install 大概率失败：[pnpm/pnpm#9623](https://github.com/pnpm/pnpm/issues/9623)、[desktop/desktop#11423](https://github.com/desktop/desktop/issues/11423)、[Azure/azure-sdk-for-js#13531](https://github.com/Azure/azure-sdk-for-js/issues/13531) 三处独立报告。社区 [#482 "Farewell, my dear Keytar"](https://github.com/atom/node-keytar/issues/482) 已宣告 EOL。 |
| **B.1 @github/keytar** | npm 7.10.6 publish 2026-02-06，repo last push 2026-04-21，但**只有 9 stars**，最后 10 commits 全是 dependabot bumps（无新 feature）。GitHub Desktop 内部 fork，非社区 first-class 替代；同样基于 keytar C++ 代码，跟 napi-rs 路径比无独立优势。 |
| **D spawn CLI** | **Windows 硬伤**：`cmdkey` 写得了密码，但**没有读密码的命令**——要从 Credential Manager 读必须走 PowerShell `Get-StoredCredential` (第三方 module) 或 P/Invoke `CredRead` Win32 API（即 native binding）。这条路要么不跨 Windows，要么退化为 hybrid（macOS+Linux CLI + Windows native），代码量 ~200 行 + 平台分支 + stderr 解析维护负担。**做了反而比 C/G.1 更不稳定**。 |
| **E 文件加密** | **跟 CLAUDE.md「凭据进 keychain」硬规则直接冲突**（明文加密 ≠ keychain）。次问题：长驻 bridge 每次启动 / 重连要用户输 passphrase = 不可用；缓存 passphrase = 自造 mini-agent；passphrase 进 keychain = 套娃回 C/G.1。仅可作为 OS keychain 不可用时的 **fallback**，不作主方案。 |
| **F keyv / node-vault** | **误命中**。`keyv` 是 cache layer 不是 secret store，自带 encryption adapter 不存在；`node-vault` 是 HashiCorp Vault HTTP client，要远程 server，跟 multi-cc-im 「local-first 单机」根本冲突。 |
| **G.2 cross-keychain** | **bus factor 1**（11 stars，magarcia 个人项目），且本质是 `@napi-rs/keyring` 的 wrapper（optionalDependency 主路径）+ 文件加密 fallback + CLI prompts。比直接用 C 多两层封装 + `@inquirer/prompts` `meow` 两个额外 deps。fallback 链复杂反而增加调试面。**直接用 C 更干净**。 |

---

## 第 2 步：尽调（A / C / G.1）

### 5 维度

| 维度 | 含义 |
|---|---|
| **跨平台覆盖** | macOS / Linux gnu / Linux musl / Windows / **headless（WSL / Docker / SSH）** 各自能跑吗 |
| **install 健壮性** | `pnpm install` 在干净机器上是否 zero-friction（关键：没装 system libsecret 的 Linux、没装 build tools 的 Windows） |
| **CLAUDE.md「凭据进 keychain」合规** | 是否真把 token 落到 OS keychain |
| **维护治理** | 维护者活跃度、bus factor、license、CVE 历史 |
| **运行时风险** | API 是否 block event loop、依赖体量、安全模型 |

---

### 候选 A：不做 keychain 集成（文档外置）

| 维度 | 评估 |
|---|---|
| 跨平台覆盖 | 跟 multi-cc-im 无关（不存 token） |
| install 健壮性 | 满分（0 deps） |
| **CLAUDE.md 合规** | **不合规**——CLAUDE.md「凭据进 keychain」硬规则，「明文落盘 = bug」。走 A 等于挑战 / 修订规则。 |
| 维护治理 | N/A |
| 运行时风险 | 把责任 outsource 给用户。看用户 setup：<br>• `.zshrc` `export ILINK_BOT_TOKEN=...`：**明文落盘**（shell rc + history + tmux scrollback 三处泄）<br>• `op run -- multi-cc-im start`（1Password CLI）：每次启动 Touch ID 二次确认，长驻 bridge 因网络断重启时尤其烦<br>• direnv + sops/age：技术上可行，但 multi-cc-im 不是 cwd-bound（bridge 在某固定目录跑），需要文档教 sops 配 age key |

**业界对照（agent 实测查证）**：

| Node.js CLI | 实际持久化 | keychain？ |
|---|---|---|
| GitHub `gh` (Go) | 优先 OS keychain，无 keychain 时 fallback `~/.config/gh/hosts.yml` 明文 | 是（[cli/cli#8954](https://github.com/cli/cli/issues/8954) 反映即使有 keychain 也写明文 fallback） |
| Vercel CLI | `~/Library/Application Support/com.vercel.cli/auth.json` 明文 | **否** |
| Firebase CLI | `~/.config/configstore/firebase-tools.json` 明文 | **否** |
| Anthropic Claude Code | macOS Keychain；Linux/Windows `~/.claude/.credentials.json` 0600 明文 | **macOS 是，Linux/Windows 否** |
| AWS CLI | `~/.aws/credentials` 明文 | **否** |

**关键发现**：Node.js CLI 生态**自带 keychain 是少数派**。Anthropic 自家 Claude Code 在 Linux/Windows 也是 0600 文件。CLAUDE.md「明文落盘 = bug」是 multi-cc-im 自定的更高标准。

**采纳 A 的代价**：要修 CLAUDE.md 规则（弱化为 "推荐 keychain，但 0600 文件可接受"）。**可行但需先决议**。

---

### 候选 C：`@napi-rs/keyring` (Brooooooklyn/keyring-node)

| 维度 | 数据 |
|---|---|
| package | [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) `1.3.0` published 2026-04-30 |
| repo | [Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node) `e46be75` 2026-04-30（**研究当天**） |
| 维护节奏 | 最近 10 commits: 04-30, 04-29×2, 04-18, 04-13×2, 04-01, 03-24, 03-20, 02-28——dependabot + 主动升级 keyring-rs v4 / TS v6 / Node 24 publish CI |
| 实现 | Rust + napi-rs 3.x，底层 [keyring-rs](https://github.com/open-source-cooperative/keyring-rs)（724 stars） |
| **跨平台 prebuilt** | **12 targets**: aarch64+x64-darwin / aarch64+x64+armv7+riscv64-linux-gnu / aarch64+x64-linux-musl / aarch64+x64+i686-windows-msvc / x64-freebsd |
| **Linux runtime libsecret** | **不需要**——Cargo.toml 启 `dbus-secret-service-keyring-store` with **`vendored` feature** + `secret-service` v5 `crypto-rust`，**libsecret 静态链接进 prebuilt binary**（[源码](https://github.com/Brooooooklyn/keyring-node/blob/main/Cargo.toml)） |
| **headless Linux** | **可用**——同时编了 `linux-keyutils-keyring-store`，无 D-Bus 时自动 fallback Linux kernel keyring（kernel keyring is ubiquitous）。这是其他候选都没有的能力 |
| dependencies | **0 prod deps**；optionalDependencies 是 12 个 `@napi-rs/keyring-<target>` 平台子包，npm/pnpm 自动选当前 platform |
| install 失败概率 | **极低**：napi-rs prebuild 模型，缺 platform binary 直接报错（不 fallback 编译） |
| 包大小 | 主包 34 KB + 平台子包 ~1 MB（每用户只装 1 个） |
| 安全模型 | macOS Keychain Services 原生 API（`security-framework` crate）；Windows DPAPI（`windows-native-keyring-store`）；Linux libsecret/D-Bus（vendored）or kernel keyutils |
| API | **同步**：`new Entry(s,n).setPassword(p)` / `.getPassword()` / `.deletePassword()`。**同步是潜在风险**——macOS 弹 unlock prompt 时挂数秒 = 阻塞 event loop。但 multi-cc-im 只在启动 + token rotation 时调（频率极低），可接受 |
| License | MIT |
| CVE | 0 advisories（GitHub Advisories DB query） |
| Node 22 / ESM | engines `>=10`；CJS export 可在 ESM `import { Entry } from '@napi-rs/keyring'` |
| **bus factor** | **1**（Brooooooklyn / LongYinan 单人主力）——但他是 napi-rs 生态创始人 + 全职维护 `@napi-rs/canvas` 等多个生产级 binding，跟 cross-keychain 那种"个人偶尔修"不是一个量级。napi-rs 整个生态依赖他，社区有 forehalo 等 contrib 支持 |

---

### 候选 G.1：`@zowe/secrets-for-zowe-sdk`

| 维度 | 数据 |
|---|---|
| package | [`@zowe/secrets-for-zowe-sdk`](https://www.npmjs.com/package/@zowe/secrets-for-zowe-sdk) `8.32.0` published 2026-04-25 |
| repo | [zowe/zowe-cli](https://github.com/zowe/zowe-cli) monorepo `packages/secrets/` |
| 实现 | Rust + napi-rs，但**不基于 keyring-rs**——Zowe 自己实现 `secrets_core` |
| **跨平台 prebuilt** | Windows x64+x86+arm64 / macOS x64+aarch64 / Linux gnu (x64+aarch64+armv7) / Linux musl (x64+aarch64) |
| **Linux runtime libsecret** | **要装 system libsecret + glib**——Cargo.toml `[target.linux] dependencies` 直接 link `libsecret = "0.4.0"` + `libsecret-sys` + `gio` + `glib`（**非 vendored**）。用户 `apt install libsecret-1-dev` 才能跑（[源码](https://github.com/zowe/zowe-cli/blob/master/packages/secrets/core/Cargo.toml)） |
| **headless Linux** | **不可用**——只走 D-Bus secret-service，无 keyutils fallback |
| dependencies | 0 prod deps（prebuilds 内置） |
| install 失败概率 | 中——install 阶段 OK（Rust binary 已 prebuilt），但**runtime 在没 libsecret 的 Linux 跑就崩** |
| 包大小 | **unpacked 4.32 MB**（所有平台 prebuilt 全打进**单包**）。比 napi-rs/keyring 的 optionalDependencies 拆包模型每用户大 3-4 倍下载 |
| 安全模型 | 同 napi-rs/keyring（macOS Keychain Services / Windows DPAPI / Linux libsecret） |
| API | **异步 Promise**：`await keyring.setPassword(s,a,p)` / `.getPassword()` / `.deletePassword()` / `.findPassword()` / `.findCredentials()`——跟 keytar API 一致，**比 napi-rs/keyring 同步 API 更安全** |
| License | **EPL-2.0** Eclipse Public License——weak copyleft。multi-cc-im 如果发布时**链接 EPL 库本身 OK**，但分发时要披露 EPL 部分修改，license compatibility 跟 multi-cc-im 主 license（暂未定，假设 MIT/Apache 主流）需要 lawyer check |
| CVE | 0 advisories |
| Node 22 / ESM | engines `>=14`；最新 8.32.0 ship 2026-04-25 supported Node 22+ |
| **bus factor** | **N（团队）**——Zowe Foundation IBM 旗下，多人维护，最低风险 |

---

## 第 3 步：对比矩阵

| 维度 | A. 不做 keychain | C. @napi-rs/keyring | G.1. @zowe/secrets-for-zowe-sdk |
|---|---|---|---|
| **package** | n/a | `@napi-rs/keyring@1.3.0` | `@zowe/secrets-for-zowe-sdk@8.32.0` |
| **最后 publish** | n/a | **2026-04-30**（DD 前一天） | 2026-04-25 |
| **archived** | n/a | 否 | 否 |
| **prod deps** | 0 | 0 | 0 |
| **macOS prebuilt** | n/a | x64 ✓ arm64 ✓ Node ≥10 | x64 ✓ arm64 ✓ Node ≥14 |
| **Linux gnu prebuilt** | n/a | x64 ✓ arm64 ✓ armv7 ✓ riscv64 ✓ | x64 ✓ arm64 ✓ armv7 ✓ |
| **Linux musl prebuilt** | n/a | ✓ | ✓ |
| **Windows prebuilt** | n/a | x64 ✓ arm64 ✓ x86 ✓ | x64 ✓ arm64 ✓ x86 ✓ |
| **Linux 无 libsecret 能跑吗** | n/a | **能**（vendored 静态链接） | **不能**（runtime link system lib） |
| **headless（WSL/SSH-only）** | n/a | **能**（kernel keyutils fallback） | **不能**（仅 D-Bus secret-service） |
| **install zero-friction** | n/a | ✓（napi prebuild + optionalDependencies） | ✓ install 阶段；runtime 在 Linux 没 libsecret 时崩 |
| **包大小（每用户实装）** | 0 | 主包 34 KB + 1 平台子包 ~1 MB | 单包 **4.3 MB** |
| **API 风格** | n/a | **同步**（潜在 event-loop 阻塞） | **异步 Promise** |
| **License** | n/a | **MIT** | **EPL-2.0**（weak copyleft，需 license check） |
| **CLAUDE.md「凭据进 keychain」** | **不合规** | 合规 | 合规 |
| **bus factor** | n/a | 1（Brooooooklyn，napi-rs 生态主理） | N（Zowe Foundation） |
| **CVE** | n/a | 0 | 0 |

> 完整证据矩阵 + 链接：见研究 agent 输出（已保存在本 PR 的 commit message + 研究日志）。每格数据均来自 GitHub API / npm registry / Cargo.toml / 官方 release notes 直接查询，非印象。

---

## 第 4 步：推荐 + 理由

**推荐 C `@napi-rs/keyring`**。

### 三条决定性理由

1. **唯一支持 headless Linux（multi-cc-im 真实部署形态）**
   multi-cc-im 是长驻 bridge，CLAUDE.md「关键设计假设」状态表明确包括 WSL 兼容。Linux 无 D-Bus 场景（headless server / Docker / SSH-only）是 multi-cc-im 的真实部署面：
   - C 编了 `linux-keyutils-keyring-store`，无 D-Bus 时**自动 fallback Linux kernel keyring**
   - G.1 仅走 D-Bus secret-service，headless 直接崩
   - A（ENV）能跑但破坏 CLAUDE.md 规则
   这一条直接淘汰 G.1 在 multi-cc-im 关键场景的可用性。

2. **Linux 部署 zero-friction（vendored libsecret）**
   - C 静态链接 libsecret 进 prebuilt binary（Cargo.toml `vendored` feature），用户 `pnpm install` 直接能跑
   - G.1 要用户先 `apt install libsecret-1-dev`，开源项目要么写文档教（增加 onboarding friction）要么 install 后 runtime 崩
   multi-cc-im 目标用户是 Claude Code 用户，不是 Linux native binding 工具链 ready 的全栈开发，**zero-friction install** 是关键非功能需求。

3. **License 干净**
   C MIT vs G.1 EPL-2.0 (weak copyleft)。multi-cc-im 主 license 暂未定（v0 设计阶段），但 EPL-2.0 链接对 future MIT/Apache 主流选择构成 compatibility 风险，要 lawyer check 才稳。直接选 MIT 库省下未来这一道。

### 已知风险 + 缓解

| 风险 | 缓解 |
|---|---|
| **同步 API 阻塞 event loop** | multi-cc-im 只在 (a) 启动读 token (b) 首次扫码登录写 token (c) token rotation 时调 keychain，频率极低（不在长轮询 hot path）。同步 macOS Keychain unlock prompt 挂数秒可接受（也是 user attention moment）。**如未来出现频率上升**，可包一层 `worker_thread` 异步化（30 行代码） |
| **Bus factor 1** | Brooooooklyn 是 napi-rs 生态创始人，活跃度极高（commit cadence 每周多次）。napi-rs 整体被多个公司生产用（Vercel、Cloudflare），**生态级关键依赖**比典型个人项目稳定。监控指标：commit cadence（>1/月即健康）、open issue 增长（不爆增即可）。如未来出现弃维信号（>3 个月无 commit + maintainer 离开），可平移到 G.1（API 不同需要重写 keychain wrapper，但工作量 < 1 周） |
| **wechat 没 typing_ticket / 凭据轮换需求时**，keychain 写错 token 不会被察觉直到 iLink 拒收 | wechat adapter `start()` 后第一次 `getUpdates` 失败时立即 surface（已有 `runMonitor.onError` 回调） |

### 走 A（不做 keychain）的成立条件

唯一可能采纳 A 的场景：**用户决定弱化 CLAUDE.md「凭据进 keychain」规则**，理由可能是：
- 业界对照（gh / vercel / firebase / claude code linux）显示明文 0600 文件是行业默认
- multi-cc-im 是单用户单机 daemon-style 部署，攻击面 ≠ 多用户共享 server
- 维护一个 keychain 集成 = 长期维护负担

**但**：bot_token 泄漏 = 攻击者扮演用户在 wechat 收/发/删消息 = 严重后果（消息含 cc session 转账等敏感内容会泄）。0600 文件防御 backup 工具 / 误 commit 还行，防御 shell scrollback / proc fs 看 cmdline / shell rc 拼接错误就不够。**multi-cc-im 是个人 dev 工具，不能假设用户 hygiene 够强**——keychain 的真实价值就是不依赖用户 hygiene。

我的判断：A 不应采纳，理由弱于 keychain 的 defense-in-depth 价值。但 **A 是个 legitimate 候选**，留给用户最终拍板。

---

## 第 5 步：留待用户决定的开放问题

1. **方案选 A / C / G.1**（强推 C，理由见第 4 步）
2. **如果选 C，sync vs async API 处理策略**:
   - 直接同步用 `Entry().getPassword()`（启动时一次，可接受）
   - 包一层 `worker_thread` / `setImmediate` async wrapper
   - **建议**: 直接同步，未来需要再包
3. **service / account namespace 命名约定**:
   - service: `multi-cc-im-wechat`（按 IM adapter 区分；未来 telegram 走 `multi-cc-im-telegram` 不冲突）
   - account: `default`（owner-only 单 account 模型，没必要按用户 ID 分；未来如要多 IM 同 service 共存可改）
   - **建议**: `service='multi-cc-im-wechat', account='default'`
4. **token 落地的 package 归属**:
   - 选项 1: 新建 `packages/auth-keychain/`，提供 `KeychainStore<T>` 通用接口，wechat adapter 注入使用
   - 选项 2: 直接放 `packages/im-wechat/src/keychain.ts`（wechat-specific）
   - **建议**: 选项 1（前瞻 tg / 飞书 adapter 也要 token 持久化，shared 抽象省后续改）—— 但 lib 设计要 IM-agnostic（项目 memory `project_future_im_adapters.md` 提醒）
5. **fallback to ENV var 是否保留**:
   - keychain 优先，ENV `ILINK_BOT_TOKEN` 兜底（开发环境 / CI 测试 / headless 极端）
   - **建议**: 保留 ENV fallback，仅在 keychain backend 整个不可用时 logger.warn 一行明示

---

## 锁定后写入 CLAUDE.md 的内容

如选 C，"关键设计假设" 表加一行：

```markdown
| Auth/keychain（bot_token 持久化）| ✓ | `@napi-rs/keyring`（vendored libsecret + keyutils fallback + MIT）；service=`multi-cc-im-<im>`, account=`default`；ENV `ILINK_BOT_TOKEN` 兜底；[DD: keychain 库选型](docs/superpowers/specs/2026-05-03-keychain-library-dd.md) |
```

"关键规范" 表 "凭据进 keychain" 那行更新：

```markdown
| **凭据进 keychain** | `bot_token` 落盘前必须经 `@napi-rs/keyring`（macOS Keychain / Windows DPAPI / Linux libsecret-vendored 或 keyutils）；明文出现在文件或日志 = bug。仅 ENV `ILINK_BOT_TOKEN` 是允许的兜底入口（dev / CI 用） |
```

如选 A，"关键规范" 整段重写为允许 0600 文件 + ENV，CLAUDE.md 多处规则联动改。

---

## 参考资料

研究 agent 完整证据收集见本 PR commit history（含 28 个直接证据链接：GitHub API queries, npm registry, Cargo.toml 源码 line refs, GitHub advisories DB queries, GitHub issues 引文）。要点链接：

- [atom/node-keytar archived](https://github.com/atom/node-keytar) — confirmed `archived: true`
- [Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node) — 1.3.0 commit `e46be75` 2026-04-30
- [keyring-node Cargo.toml (vendored linux backend)](https://github.com/Brooooooklyn/keyring-node/blob/main/Cargo.toml)
- [zowe-cli secrets/core/Cargo.toml (system libsecret)](https://github.com/zowe/zowe-cli/blob/master/packages/secrets/core/Cargo.toml)
- [@zowe/secrets-for-zowe-sdk on npm](https://www.npmjs.com/package/@zowe/secrets-for-zowe-sdk) — 8.32.0 EPL-2.0
- [pnpm/pnpm#9623 keytar Node 22 install fail](https://github.com/pnpm/pnpm/issues/9623)
- [cli/cli#8954 gh keychain plain text fallback](https://github.com/cli/cli/issues/8954)
- [Anthropic Claude Code authentication docs](https://code.claude.com/docs/en/authentication) — Linux/Windows 0600 file
- [keyring-rs#133 missing default Linux keyring](https://github.com/open-source-cooperative/keyring-rs/issues/133)
- [jaraco/keyring#477 headless Ubuntu container](https://github.com/jaraco/keyring/issues/477)
- [magarcia/cross-keychain](https://github.com/magarcia/cross-keychain) — 11 stars
