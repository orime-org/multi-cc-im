# 配置飞书自建应用

`multi-cc-im` 需要飞书自建应用（企业自建应用）的 `App ID` 和 `App Secret`。完成以下步骤后，回到 wizard 填入凭据。

## 1. 创建应用

访问 [飞书开放平台](https://open.feishu.cn/app)，点击「创建企业自建应用」。填名字、简介、icon。

## 2. 启用机器人能力

进入应用 → 「应用功能」→ 启用机器人。

## 3. 拿凭据

「凭证与基础信息」→ 抄下：

- **App ID** (`cli_xxx`) — 公开标识符，复制即可
- **App Secret** — 长随机串。**只显示一次**，丢了得点「重置」重抄

## 4. 事件订阅 — 必须 WebSocket

「事件与回调」→「事件订阅」：

- 接收方式：选 **WebSocket**（**不是**「事件请求地址 / Webhook」）
- 订阅事件：添加 `接收消息 v2.0`（事件名 `im.message.receive_v1`）

## 5. 权限

「权限管理」→ 添加：

- `im:message:send_as_bot` — 以应用身份发消息（必需）
- `im:message.p2p_msg:readonly` — 接收单聊消息（最简单的测试路径）
- 可选：`im:message.group_at_msg:readonly` — 群里 @ 机器人时收到消息

## 6. 发布

「版本管理与发布」→ 创建版本 → 提交发布。**不发布权限和事件订阅不生效。**

## 7. 添加 bot 为联系人

在飞书 app 里搜机器人名 → 添加为联系人 / 发起单聊，准备测试。

---

完成上述步骤后，wizard 会提示填 `App ID` 和 `App Secret`。
