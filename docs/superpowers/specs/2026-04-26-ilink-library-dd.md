# iLink 协议库选型 DD 报告

**Topic**: multi-cc-im 项目 IM adapter 层的微信 iLink 协议实现选型  
**Date**: 2026-04-26  
**Status**: ✅ 已锁定  
**结论**: **抽取 vendor `Tencent/openclaw-weixin` v2.1.7 的协议层代码**

> 本报告按 CLAUDE.md "重大决策 DD 流程" 的 5 步走完：候选枚举 → 逐个尽调 → 对比矩阵 → 基于证据推荐 → 用户决定。

---

## 决策摘要

选定 **A1 抽取 vendor**：把 `Tencent/openclaw-weixin` repo 的 `src/{api,auth,cdn,messaging,media,util,storage,config}/` 8 个协议子目录复制进 `packages/im-wechat/lib/ilink/`；删除 `runtime.ts` 引用，重写 `monitor.ts` 去除 OpenClaw 依赖；保留 MIT LICENSE，记录 `VENDOR.md` 含 upstream commit hash。

**Upstream 固定版本**：`Tencent/openclaw-weixin` v2.1.7，commit `6e58a2b`（2026-04-07）。

## 候选枚举（DD 第 1 步）

通过 `gh search code` 三个 iLink 协议特征字符串（`ilinkai.weixin.qq.com` / `/ilink/bot/getupdates` / `ilink_bot_token`）+ `gh search repos` 多关键词扫描，发现 **30+ iLink 实现**遍布 7 种语言。按"分档"原则筛后 5 个进入 DD：

| ID | 候选 | 分类 | 进 DD |
|---|---|---|---|
| A1 | `Tencent/openclaw-weixin` | OpenClaw 插件，但协议层独立 | ✓ |
| A2 | `hao-ji-xing/openclaw-weixin` | demo（不是协议库），排除 | × |
| A3 | `photon-hq/wechat-ilink-client` | 独立协议库 | ✓ |
| A4 | `co-pine/wx-robot-ilink` | demo（不是协议库），排除 | × |
| A6 | `crazynomad/weixin-ilink` | 独立协议库（5 endpoints 子集） | ✓ |
| C1 | `chenhg5/cc-connect` | Go monolith 内嵌（语言 + 架构耦合，排除）| × |
| D | from scratch | 协议跟进负担转嫁自己（排除）| × |

更多搜索结果数据归档：`.playwright-mcp/ilink-search.txt`（gitignored）。

## 5 维度尽调（DD 第 2 步）

详细数据归档：`.playwright-mcp/ilink-dd-step2.txt`、`ilink-dd-step2-pkg.txt`、`ilink-dd-step2-deep.txt`（均 gitignored）。

### 实测层
*因涉及微信号扫码 + bot_token 申请，未在本次 DD 内实测；待 v1 实施时由用户参与扫码确认 QR 登录、长轮询、sendmessage 三条最小 path。*

### 源码层

| 维度 | A1 | A3 | A6 |
|---|---|---|---|
| 体量 | 198 KB / 多模块 | 44 KB | 29 KB |
| 模块化 | 高（8 个子目录分职责）| 中 | 低（5 个文件平铺）|
| 测试覆盖 | **强**（每子目录有 .test.ts，10+ 测试文件） | 无（仅 examples）| 弱（test/ 仅 1 文件） |
| 协议覆盖 | 完整 7 endpoints + **高级特性**：`StreamingMarkdownFilter` / `silk-transcode` / `context-token-store` / `sync-buf` / `pic-decrypt` / `debug-mode` / `error-notice` / `pairing` | 7 endpoints 完整，无高级特性 | 5 endpoints（缺 QR 登录的 2 个 GET） |
| 依赖外部框架 | OpenClaw（**只在 `runtime.ts` + `monitor/monitor.ts` 2 个文件**，全部 type-only import）| 零 | 零 |

### 治理层

| 维度 | A1 | A3 | A6 |
|---|---|---|---|
| Stars | 278 | 48 | 5 |
| Forks | 63 | 9 | 1 |
| Open issues | 57 | 2 | 0 |
| 创建 → 最近 push | 2026-03-27 → 2026-04-07（活 11 天）| 2026-03-22 单天后停 | 2026-03-27 单天后停 |
| commit 频率（近 100）| 19（持续）| 2 | 2 |
| 维护者 | Pumpkin Xing（疑似腾讯员工）| qwerzl 个人 | greentrain 个人 |
| Release 节奏 | v2.0 → v2.1.7（语义化版本，规律 release）| v0.1.0 | v0.1.0 |

### 安全层

| 维度 | A1 | A3 | A6 |
|---|---|---|---|
| License | **MIT**（LICENSE 文件，`Tencent is pleased to support...` 前缀；GitHub SPDX 误判为 NOASSERTION 是 metadata bug）| MIT (package.json) | MIT (package.json) |
| 外部 HTTP | 仅 `ilinkai.weixin.qq.com` + CDN | 同 | 同 |
| 用户数据上传 | 仅协议必需 | 同 | 同 |
| 已知 CVE | 无（待 v1 实施时跑 npm audit）| 无 | 无 |

### 协议跟进层

| 维度 | A1 | A3 | A6 |
|---|---|---|---|
| 升级响应 | ✅ 官方持续 release（v2.1.7 在 2026-04-07）| ❌ stuck v0.1.0 | ❌ stuck v0.1.0 |
| 历史 git pattern | 持续 release 模式 | 单作者一次性提交 | 单作者一次性提交 |
| 风险评估 | **低**（腾讯改协议必跟进）| 中（CHANGELOG 显示协议层相对稳定，但若 breaking 无人跟）| 中 |

## 对比矩阵（DD 第 3 步）

| 维度 | A1 抽取 vendor | A3 整包 vendor | A6 直接 vendor |
|---|---|---|---|
| License | MIT ✓ | MIT ✓ | MIT ✓ |
| 协议正确性 | **官方源** | 逆向自 A1 | 逆向自 A1（且 5 endpoints 子集） |
| 测试覆盖 | 每子目录 .test.ts | 无 | 1 文件 |
| 高级特性 | StreamingMarkdownFilter / Silk / context-token-store 等 | 无 | 无 |
| 协议跟进 | 官方持续 | stuck | stuck |
| 抽取/Vendor 难度 | 中（删 runtime + 重写 monitor ~150 行）| 低（直接 vendor src/）| 低 |
| v1 工作量 | ~1 天 | ~半天 | ~半天 |
| 长期维护 | 每月 ~1 小时 sync upstream | 协议 breaking 时 1-2 天 fork | 同 |
| 风险点 | OpenClaw 抽离时漏改 | 协议 breaking 无人跟（年内概率 < 30%）| 同 + endpoint 缺失 |

## 推荐 + 理由（DD 第 4 步）

**推荐 A1 抽取 vendor**。决定性证据（每条可追溯到 DD 矩阵）：

1. **官方源 = 协议正确性最高**（A3/A6 是逆向自 A1，相当于 A3/A6 = 二手货）
2. **测试覆盖让"协议正确性"从信任降级为可验证**（A1 每子目录 .test.ts，A3/A6 无测试）
3. **OpenClaw 依赖只在 2 个 type-only 文件**（grep `from "openclaw"` 全树扫描结果），可抽离
4. **高级特性现成**（StreamingMarkdownFilter / silk-transcode / context-token-store / pic-decrypt 等），省 v1 ~200 行实现 + 调试
5. **长期 sync 成本（每月 1 小时） << 中途切换的总成本**

排除 A3 的核心理由：
- A3 是 reverse-engineered 自 A1，跟 A1 同族但**少了所有高级特性 + 测试**
- A3 死项目（v0.1.0 stuck），protocol breaking 时无人跟
- 工作量节省（半天 vs 1 天）不足以抵消协议正确性 + 测试覆盖损失

排除 from scratch 的核心理由：
- A3/A6 已经替"个人协议库"这条路演示过命运（死项目）
- 自己写出来跟 A3 没本质差异，只是再死一次

## 用户决定（DD 第 5 步）

**用户拍板**：A1 抽取 vendor。  
锁定时间：2026-04-26  
确认依据：本 DD 报告 + brainstorming 对话历史。

---

## 实施清单（v1 落地步骤）

```
1. 拉取 upstream
   git clone https://github.com/Tencent/openclaw-weixin.git /tmp/openclaw-weixin
   cd /tmp/openclaw-weixin && git checkout 6e58a2b   # v2.1.7

2. 创建 vendor 目录
   mkdir -p packages/im-wechat/lib/ilink

3. 复制协议子目录（保留 .test.ts）
   for d in api auth cdn messaging media util storage config; do
     cp -r /tmp/openclaw-weixin/src/$d packages/im-wechat/lib/ilink/
   done

4. 复制 LICENSE
   cp /tmp/openclaw-weixin/LICENSE packages/im-wechat/lib/ilink/LICENSE.upstream

5. 创建 VENDOR.md（origin URL / commit / sync 步骤 / 改造说明）

6. 删除 runtime.ts 引用
   grep -rl "from \"../runtime" packages/im-wechat/lib/ilink/
   # 把所有 import 替换成自己的 ChannelRuntime mock

7. 重写 monitor.ts
   # 去除 OpenClaw PluginRuntime 依赖，改成 EventEmitter + callback

8. 包成 IMAdapter
   # packages/im-wechat/src/adapter.ts 实现 shared/IMAdapter 接口
   # 内部调 lib/ilink

9. 跑 vendored test
   cd packages/im-wechat && pnpm vitest run lib/ilink

10. 写 sync script
    scripts/sync-vendor-ilink.sh：
    - 拉 upstream
    - diff 当前 vendored vs upstream，列出 8 个子目录的影响 commit
    - 输出 cherry-pick 提示（人工 review）
```

## 风险与缓解

| 风险 | 概率 | 严重度 | 缓解 |
|---|---|---|---|
| OpenClaw runtime 抽离时漏改 | 中 | 高 | grep `from "openclaw"` 全量扫描 + 跑 vendored .test.ts 兜底 |
| upstream 大改协议导致 sync 工作量爆炸 | 低 | 中 | sync script 给出 commit 列表 + 影响子目录提示，每月扫描 |
| upstream 撤下仓库 / 改 license | 极低 | 低 | vendor 后跟 upstream 解耦，本地副本永远可用（MIT 已固定授权）|
| 测试因 OpenClaw mock 不完整失败 | 中 | 中 | 先 skip 涉及 OpenClaw runtime 的 test 文件，保留纯协议测试 |
| upstream 加新依赖（如 silk-wasm 等）影响 vendor 体积 | 中 | 低 | 评估时按需 vendor（已知 devDependency `silk-wasm` 是 silk 解码器，可选）|

## 参考资料

- DD 数据归档（gitignored 本地）：
  - `.playwright-mcp/ilink-search.txt`（候选枚举搜索结果）
  - `.playwright-mcp/ilink-dd-step2.txt`（候选 metadata + commit history）
  - `.playwright-mcp/ilink-dd-step2-pkg.txt`（package.json + LICENSE + 主入口源码）
  - `.playwright-mcp/ilink-dd-step2-deep.txt`（A1 子目录结构 + CHANGELOG + OpenClaw import grep）
- Upstream：https://github.com/Tencent/openclaw-weixin
- 当前固定版本：v2.1.7（commit `6e58a2b`, 2026-04-07）
- 备选 A3：https://github.com/photon-hq/wechat-ilink-client（如 v1 出现 A1 抽取不可行时切换到此路径，本 DD 报告需更新）

## 链接

- brainstorming 主流程：参考会话 task list（task #3 `Run clarifying-questions loop on 16 decision points`）
- CLAUDE.md "重大决策 DD 流程" 节：定义本 DD 报告的产出标准
