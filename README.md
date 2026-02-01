# @tobeyoureyes/feishu

飞书/Lark 企业消息平台的 OpenClaw 插件。支持私聊、群聊、消息回复、媒体处理和卡片消息渲染。

## 概述

此插件将飞书作为消息通道添加到 OpenClaw，使你的 AI 机器人能够：

- 接收和回复私聊消息
- 在群聊中被 @提及 后回复
- 处理图片、文件等媒体消息
- 使用卡片格式渲染代码块、表格等富文本
- 通过 WebSocket 长连接实时接收消息

## 安装

```bash
openclaw plugins install @tobeyoureyes/feishu
```

## 快速开始

### 1. 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用
3. 获取 App ID 和 App Secret
4. 在"事件订阅"中启用"使用长连接接收事件"
5. 订阅 `im.message.receive_v1` 事件
6. 发布应用版本

### 2. 配置 OpenClaw

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxxxx"
    appSecret: "your-app-secret"
    # 或使用环境变量
    # appId: "${FEISHU_APP_ID}"
    # appSecret: "${FEISHU_APP_SECRET}"
```

### 3. 启动

```bash
openclaw start
```

## 配置选项

### 基础配置

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用飞书通道 |
| `appId` | string | - | 飞书应用 App ID |
| `appSecret` | string | - | 飞书应用 App Secret |
| `domain` | string | `"feishu"` | API 域名：`"feishu"` (国内) 或 `"lark"` (国际) |
| `connectionMode` | string | `"websocket"` | 连接模式：`"websocket"` (推荐) 或 `"webhook"` |

### 访问控制

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dmPolicy` | string | `"pairing"` | 私聊策略：`"pairing"` / `"allowlist"` / `"open"` / `"disabled"` |
| `allowFrom` | string[] | `[]` | 允许的发送者 ID 列表 |
| `groupPolicy` | string | `"allowlist"` | 群聊策略：`"allowlist"` / `"open"` / `"disabled"` |
| `requireMention` | boolean | `true` | 群聊是否需要 @机器人 才回复 |
| `groups` | object | `{}` | 群聊配置，如 `{ "oc_xxx": { enabled: true } }` |

### 消息渲染

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `renderMode` | string | `"auto"` | 渲染模式：`"auto"` / `"raw"` / `"card"` |
| `mediaMaxMb` | number | `30` | 最大媒体文件大小 (MB) |

### 渲染模式说明

| 模式 | 说明 |
|------|------|
| `auto` | 自动检测：有代码块、表格、链接或长文本时使用卡片，否则纯文本 |
| `raw` | 始终纯文本，表格转为 ASCII 格式 |
| `card` | 始终使用卡片，支持 Markdown 语法高亮、表格、链接等 |

## 访问控制策略

### 私聊策略 (dmPolicy)

| 策略 | 说明 |
|------|------|
| `pairing` | 默认。未知发送者会收到配对码，需要管理员审批 |
| `allowlist` | 只有 `allowFrom` 列表中的用户可以发消息 |
| `open` | 任何人都可以发消息（谨慎使用） |
| `disabled` | 禁用私聊 |

### 群聊策略 (groupPolicy)

| 策略 | 说明 |
|------|------|
| `allowlist` | 默认。只有 `groups` 中配置的群可以使用机器人 |
| `open` | 所有群都可以使用机器人（需配合 `requireMention`） |
| `disabled` | 禁用群聊 |

## 功能特性

### 支持的消息类型

- **接收**：文本、富文本 (post)、图片、文件、音频、视频、卡片、分享
- **发送**：文本、富文本、图片、文件、卡片

### 消息处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                    飞书消息处理流程                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  WebSocket/Webhook ──► 解析事件 ──► 消息去重                  │
│         │                             │                      │
│         │                             ▼                      │
│         │                       策略检查                      │
│         │                    (dmPolicy/groupPolicy)          │
│         │                             │                      │
│         │                             ▼                      │
│         │                      @ 提及检测                     │
│         │                    (群聊 requireMention)           │
│         │                             │                      │
│         │                             ▼                      │
│         │               获取回复上下文 (parent_id)            │
│         │                             │                      │
│         │                             ▼                      │
│         │                   构建群聊历史上下文                 │
│         │                             │                      │
│         │                             ▼                      │
│         │                      AI Agent 处理                  │
│         │                             │                      │
│         │                             ▼                      │
│         │                      渲染模式判断                    │
│         │                    (auto/raw/card)                 │
│         │                             │                      │
│         └─────────────────────► 发送回复                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 群聊上下文

当机器人被 @提及 时，会自动收集该群最近的未处理消息作为上下文，帮助 AI 理解对话背景。

### 回复引用

当用户回复某条消息时，机器人会自动获取被回复消息的内容作为上下文。

### 卡片消息

自动检测以下内容并使用卡片渲染：

- 代码块 (```code```)
- 表格 (|header|)
- Markdown 链接 [text](url)
- 长文本 (>500 字符)
- 多段落 (>=3 个空行)

## 多账户配置

```yaml
channels:
  feishu:
    enabled: true
    # 默认账户配置
    appId: "cli_default"
    appSecret: "secret_default"
    
    # 命名账户
    accounts:
      production:
        enabled: true
        appId: "cli_prod"
        appSecret: "secret_prod"
        dmPolicy: "allowlist"
        allowFrom: ["ou_xxx", "ou_yyy"]
      
      testing:
        enabled: true
        appId: "cli_test"
        appSecret: "secret_test"
        dmPolicy: "open"
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

## 故障排除

### 机器人不接收消息

1. 确认应用已发布且已启用
2. 检查"事件订阅"是否启用了"使用长连接接收事件"
3. 确认已订阅 `im.message.receive_v1` 事件
4. 检查应用权限：需要 `im:message`、`im:message:receive`

### 群聊不回复

1. 确认 `groupPolicy` 不是 `"disabled"`
2. 如果 `groupPolicy` 是 `"allowlist"`，确认群 ID 在 `groups` 配置中
3. 如果 `requireMention` 是 `true`，确认消息中 @了机器人

### 私聊不回复

1. 确认 `dmPolicy` 不是 `"disabled"`
2. 如果是 `"pairing"` 模式，用户需要先完成配对审批
3. 如果是 `"allowlist"` 模式，确认用户 ID 在 `allowFrom` 列表中

### WebSocket 连接失败

1. 检查网络连接
2. 确认 App ID 和 App Secret 正确
3. 检查应用是否已发布
4. 查看日志中的具体错误信息

## API 参考

### 卡片创建函数

```typescript
import {
  createSimpleCard,
  createMarkdownCard,
  createCodeCard,
  createTableCard,
  createCardWithButtons,
  createMultiSectionCard,
} from "@tobeyoureyes/feishu/api";

// 简单卡片
const card1 = createSimpleCard("标题", "Markdown 内容", "blue");

// 代码卡片
const card2 = createCodeCard("console.log('hello')", "javascript", "示例代码");

// 表格卡片
const card3 = createTableCard(
  ["名称", "值"],
  [["项目1", "100"], ["项目2", "200"]],
  "数据表格"
);

// 按钮卡片
const card4 = createCardWithButtons(
  "请选择操作",
  [
    { text: "确认", value: "confirm", type: "primary" },
    { text: "取消", value: "cancel", type: "default" },
  ],
  "操作确认"
);
```

## 文件结构

```
chat_feishu/
├── src/
│   ├── api.ts        # Feishu API 封装
│   ├── auth.ts       # Token 认证管理
│   ├── channel.ts    # 插件主入口
│   ├── dedupe.ts     # 消息去重模块
│   ├── history.ts    # 群聊历史管理
│   ├── inbound.ts    # 入站消息处理
│   ├── message.ts    # 消息格式化工具
│   ├── runtime.ts    # 运行时上下文
│   ├── types.ts      # 类型定义
│   ├── webhook.ts    # Webhook 事件解析
│   └── websocket.ts  # WebSocket 连接管理
├── index.ts          # 模块导出
├── package.json
└── README.md
```

## 许可证

MIT
