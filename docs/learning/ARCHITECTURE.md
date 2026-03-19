# OpenClaw 架构文档

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [核心架构](#3-核心架构)
4. [模块详解](#4-模块详解)
5. [工作流程](#5-工作流程)
6. [数据流](#6-数据流)
7. [插件系统](#7-插件系统)
8. [安全架构](#8-安全架构)
9. [部署架构](#9-部署架构)
10. [扩展指南](#10-扩展指南)

---

## 1. 项目概述

**OpenClaw** 是一个**本地优先的个人 AI 助手平台**，核心设计理念：

- **本地运行**：Gateway 运行在用户设备上，数据不离开本地
- **多渠道接入**：支持 20+ 消息平台统一接入
- **插件化扩展**：核心精简，功能通过插件扩展
- **安全默认**：内置多层安全机制

### 1.1 核心能力

| 能力 | 描述 |
|------|------|
| 多渠道消息 | WhatsApp、Telegram、Slack、Discord、微信等 20+ 平台 |
| 多模型支持 | OpenAI、Claude、Gemini、本地模型等 |
| 语音交互 | Voice Wake（语音唤醒）、Talk Mode（对话模式） |
| 可视化画布 | Canvas 实时渲染、A2UI 动态界面 |
| 浏览器控制 | 自动化浏览器操作、网页抓取 |
| 定时任务 | Cron 调度、Webhook 触发 |
| 移动端支持 | macOS、iOS、Android 原生应用 |

---

## 2. 技术栈

### 2.1 核心技术

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **运行时** | Node.js ≥22 | TypeScript 执行环境 |
| **语言** | TypeScript | 类型安全的开发体验 |
| **包管理** | pnpm workspace | Monorepo 架构 |
| **协议** | WebSocket | Gateway 实时通信 |
| **验证** | Ajv + Zod | Schema 验证 |

### 2.2 移动端技术

| 平台 | 技术栈 |
|------|--------|
| **macOS** | Swift + SwiftUI |
| **iOS** | Swift + SwiftUI + Watch App |
| **Android** | Kotlin + Jetpack Compose |

### 2.3 依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                      External Dependencies                   │
├─────────────────────────────────────────────────────────────┤
│  @mariozechner/pi-coding-agent  │  AI Agent 核心运行时       │
│  @mariozechner/pi-ai            │  AI 模型抽象层             │
│  Ajv                            │  JSON Schema 验证          │
│  Zod                            │  运行时类型验证            │
│  ws                             │  WebSocket 服务器          │
│  express                        │  HTTP 服务器               │
│  playwright                     │  浏览器自动化              │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心架构

### 3.1 架构全景图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           用户交互层 (Presentation)                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐│
│  │   CLI   │  │macOS App│  │ iOS App │  │Android  │  │  WebChat/Control││
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────────┬────────┘│
└───────┼────────────┼────────────┼────────────┼─────────────────┼─────────┘
        │            │            │            │                 │
        └────────────┴────────────┴────────────┴─────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Gateway 控制平面 (Control Plane)                  │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                     WebSocket Server (ws://127.0.0.1:18789)        │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Protocol   │  │   Auth &     │  │   Session    │  │   Config    │ │
│  │   Schema     │  │   Security   │  │   Manager    │  │   Manager   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Server Methods: chat, agent, cron, nodes, secrets, skills, ...   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent 运行时 (Runtime Layer)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Pi Agent    │  │    Tool      │  │   Sandbox    │  │   Memory    │ │
│  │  (RPC Mode)  │  │   Catalog    │  │   Executor   │  │   Backend   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Context    │  │   Skills     │  │   Browser    │  │   Canvas    │ │
│  │   Manager    │  │   System     │  │   Control    │  │    Host     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Channels 渠道层 (Channel Layer)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Channel    │  │   Message    │  │   Outbound   │  │   Inbound   │ │
│  │   Registry   │  │   Normalizer │  │   Adapter    │  │   Handler   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Plugins: telegram, whatsapp, discord, slack, signal, imessage... │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Extensions 插件层 (Plugin Layer)                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ Channel Plugins │  │   Auth Plugins  │  │     Tool Plugins       │ │
│  │ discord, slack, │  │ google-gemini,  │  │ browser, diffs,        │ │
│  │ telegram, zalo  │  │ minimix-portal  │  │ lobster, llm-task      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ Memory Plugins  │  │   ACP Plugins   │  │   Diagnostic Plugins   │ │
│  │ memory-core,    │  │      acpx       │  │   diagnostics-otel     │ │
│  │ memory-lancedb  │  │                 │  │                         │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      基础设施层 (Infrastructure Layer)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Network    │  │    File      │  │   Process    │  │   Daemon    │ │
│  │   (SSRF)     │  │   System     │  │   Manager    │  │   Service   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Logging    │  │   Backup     │  │   Install    │  │   Bonjour   │ │
│  │   System     │  │   System     │  │   Manager    │  │   Discovery │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构

```
openclaw/
├── src/                        # 核心源码
│   ├── gateway/               # Gateway 控制平面
│   │   ├── protocol/          # WebSocket 协议定义
│   │   │   └── schema/        # JSON Schema 定义
│   │   └── server-methods/    # RPC 方法实现
│   ├── agents/                # Agent 运行时
│   │   ├── sandbox/           # 沙箱执行环境
│   │   ├── skills/            # 技能系统
│   │   └── tools/             # 工具定义
│   ├── channels/              # 渠道抽象层
│   │   └── plugins/           # 渠道插件
│   │       ├── outbound/      # 出站消息适配器
│   │       ├── onboarding/    # 渠道配置向导
│   │       └── actions/       # 渠道动作处理
│   ├── cli/                   # 命令行界面
│   │   └── program/           # CLI 路由
│   ├── config/                # 配置系统
│   │   └── types.*.ts         # 类型定义
│   ├── infra/                 # 基础设施
│   │   ├── net/               # 网络安全
│   │   └── outbound/          # 出站消息投递
│   ├── cron/                  # 定时任务
│   │   └── service/           # Cron 服务
│   ├── daemon/                # 守护进程管理
│   ├── plugins/               # 插件系统核心
│   ├── auto-reply/            # 自动回复逻辑
│   ├── browser/               # 浏览器控制
│   ├── canvas-host/           # Canvas 服务
│   └── acp/                   # ACP 协议
├── extensions/                # 扩展插件
│   ├── discord/               # Discord 插件
│   ├── slack/                 # Slack 插件
│   ├── telegram/              # Telegram 插件
│   ├── whatsapp/              # WhatsApp 插件
│   └── ...                    # 其他插件
├── skills/                    # 技能包
│   ├── github/                # GitHub 技能
│   ├── notion/                # Notion 技能
│   └── ...                    # 其他技能
├── apps/                      # 移动端应用
│   ├── macos/                 # macOS 应用
│   ├── ios/                   # iOS 应用
│   └── android/               # Android 应用
├── docs/                      # 文档
└── scripts/                   # 构建脚本
```

---

## 4. 模块详解

### 4.1 Gateway（网关控制平面）

**路径**: `src/gateway/`

**职责**: 整个系统的中央协调器，处理所有客户端连接和请求路由。

#### 4.1.1 协议层 (Protocol)

**路径**: `src/gateway/protocol/`

```typescript
// 协议消息类型
type GatewayMethod = 
  | 'chat.send'      // 发送消息
  | 'chat.history'   // 获取历史
  | 'chat.abort'     // 中止对话
  | 'agent.wait'     // 等待 Agent
  | 'config.get'     // 获取配置
  | 'config.set'     // 设置配置
  | 'cron.add'       // 添加定时任务
  | 'nodes.invoke'   // 调用节点
  | 'secrets.get'    // 获取密钥
  | 'skills.list'    // 列出技能
  // ... 更多方法
```

#### 4.1.2 服务方法 (Server Methods)

**路径**: `src/gateway/server-methods/`

| 方法文件 | 功能描述 |
|----------|----------|
| `chat.ts` | 处理聊天消息、历史记录、消息注入 |
| `agent.ts` | Agent 状态查询、等待 Agent 完成 |
| `config.ts` | 配置读取、更新、Schema 查询 |
| `cron.ts` | 定时任务管理 |
| `nodes.ts` | 设备节点调用（相机、位置等） |
| `secrets.ts` | 密钥管理 |
| `skills.ts` | 技能管理 |
| `browser.ts` | 浏览器控制 |
| `doctor.ts` | 系统诊断 |

#### 4.1.3 认证与安全

**路径**: `src/gateway/auth.ts`

```typescript
// 认证流程
type AuthFlow = {
  // 1. 设备认证
  deviceAuth: {
    deviceId: string;
    token: string;
  };
  
  // 2. 连接认证
  connectionAuth: {
    connId: string;
    role: 'admin' | 'user' | 'device';
  };
  
  // 3. 方法权限
  methodScopes: {
    method: string;
    requiredScope: string[];
  };
};
```

### 4.2 Agents（代理运行时）

**路径**: `src/agents/`

**职责**: AI Agent 的核心执行环境，管理工具调用、上下文、沙箱执行。

#### 4.2.1 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Runtime                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Pi Agent    │  │   Tool      │  │    Context          │ │
│  │ (RPC Mode)  │──│   Catalog   │──│    Manager          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         │                │                    │             │
│         ▼                ▼                    ▼             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Sandbox   │  │   Skills    │  │    Session          │ │
│  │  Executor   │  │   System    │  │    Management       │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2.2 工具目录 (Tool Catalog)

**路径**: `src/agents/pi-tools.ts`

```typescript
// 工具分类
type ToolCategory = {
  // 文件操作
  file: ['read', 'write', 'edit', 'apply_patch'];
  
  // 系统命令
  system: ['exec', 'process'];
  
  // 浏览器
  browser: ['navigate', 'click', 'type', 'screenshot'];
  
  // 渠道操作
  channel: ['send_message', 'create_channel', 'invite_user'];
  
  // 节点操作
  node: ['camera', 'location', 'notification'];
  
  // Canvas
  canvas: ['push', 'reset', 'snapshot'];
};
```

#### 4.2.3 沙箱执行

**路径**: `src/agents/sandbox.ts`

```typescript
// 沙箱策略
type SandboxPolicy = {
  // 文件系统隔离
  fs: {
    allowedPaths: string[];
    deniedPaths: string[];
  };
  
  // 命令执行
  exec: {
    allowedBins: string[];
    deniedPatterns: string[];
  };
  
  // 网络访问
  network: {
    allowedHosts: string[];
    ssrfProtection: boolean;
  };
};
```

### 4.3 Channels（渠道层）

**路径**: `src/channels/`

**职责**: 多渠道消息的统一抽象和路由。

#### 4.3.1 渠道注册表

**路径**: `src/channels/registry.ts`

```typescript
// 支持的渠道
const CHANNEL_IDS = [
  'telegram',
  'whatsapp',
  'discord',
  'slack',
  'signal',
  'imessage',
  'googlechat',
  'matrix',
  'irc',
  'line',
  'msteams',
  'feishu',
  'mattermost',
  'nostr',
  'zalo',
  // ... 更多
] as const;
```

#### 4.3.2 消息流向

```
┌──────────────────────────────────────────────────────────────┐
│                     Inbound Message Flow                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  External Platform (WhatsApp/Telegram/etc.)                  │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────┐                                        │
│  │ Channel Plugin  │  接收原始消息                           │
│  │ (Inbound)       │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │   Normalizer    │  标准化消息格式                         │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │  Pairing Check  │  检查发送者配对状态                     │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │    Gateway      │  路由到 Agent                           │
│  │   Dispatcher    │                                        │
│  └─────────────────┘                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    Outbound Message Flow                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Agent Response                                             │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────┐                                        │
│  │   Deliver.ts    │  消息投递调度                           │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │  Chunker        │  消息分块（适配平台限制）               │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Channel Adapter │  平台特定适配器                         │
│  │ (Outbound)      │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  External Platform                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 4.3.3 出站适配器

**路径**: `src/channels/plugins/outbound/`

| 适配器 | 平台 | 特殊处理 |
|--------|------|----------|
| `telegram.ts` | Telegram | 4096 字符限制、Markdown 格式 |
| `whatsapp.ts` | WhatsApp | 媒体压缩、QR 登录 |
| `discord.ts` | Discord | Embed、按钮、下拉菜单 |
| `slack.ts` | Slack | Block Kit、模态框 |
| `signal.ts` | Signal | 端到端加密、样式文本 |
| `imessage.ts` | iMessage | AppleScript 集成 |

### 4.4 CLI（命令行界面）

**路径**: `src/cli/`

**职责**: 用户交互入口，提供完整的命令行工具集。

#### 4.4.1 主要命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `gateway` | 启动/管理网关 | `openclaw gateway --port 18789` |
| `agent` | 与 AI 交互 | `openclaw agent --message "Hello"` |
| `onboard` | 引导式配置 | `openclaw onboard --install-daemon` |
| `doctor` | 系统诊断 | `openclaw doctor` |
| `config` | 配置管理 | `openclaw config get` |
| `cron` | 定时任务 | `openclaw cron add "0 9 * * *"` |
| `nodes` | 节点管理 | `openclaw nodes invoke camera.snap` |
| `skills` | 技能管理 | `openclaw skills install github` |

#### 4.4.2 命令路由

**路径**: `src/cli/program/routes.ts`

```typescript
// 命令路由结构
type CommandRoute = {
  command: string;
  handler: () => Promise<void>;
  subcommands?: CommandRoute[];
};
```

### 4.5 Config（配置系统）

**路径**: `src/config/`

**职责**: 配置管理、Schema 验证、类型定义。

#### 4.5.1 配置结构

```typescript
// 主配置结构
type OpenClawConfig = {
  // Agent 配置
  agents: {
    defaults: AgentDefaults;
    models: ModelConfig[];
  };
  
  // 渠道配置
  channels: {
    telegram?: TelegramConfig;
    whatsapp?: WhatsAppConfig;
    discord?: DiscordConfig;
    // ... 更多渠道
  };
  
  // 认证配置
  auth: {
    providers: AuthProvider[];
  };
  
  // 工具配置
  tools: {
    policy: ToolPolicy;
    catalog: ToolCatalog;
  };
  
  // 定时任务
  cron: CronConfig[];
  
  // 钩子
  hooks: HookConfig;
};
```

#### 4.5.2 类型定义

**路径**: `src/config/types.*.ts`

配置类型按领域拆分：
- `types.agents.ts` - Agent 相关类型
- `types.channels.ts` - 渠道相关类型
- `types.models.ts` - 模型相关类型
- `types.tools.ts` - 工具相关类型
- `types.cron.ts` - 定时任务类型

### 4.6 Infrastructure（基础设施）

**路径**: `src/infra/`

**职责**: 底层基础设施，包括网络、文件、进程、安全等。

#### 4.6.1 网络安全

**路径**: `src/infra/net/`

```typescript
// SSRF 防护
type SSRFProtection = {
  // 允许的主机
  allowedHosts: string[];
  
  // 禁止的 IP 范围
  deniedIPRanges: string[];
  
  // 代理配置
  proxy: {
    http?: string;
    https?: string;
  };
};
```

#### 4.6.2 出站投递

**路径**: `src/infra/outbound/`

```typescript
// 消息投递流程
type DeliveryFlow = {
  // 1. 消息入队
  enqueue: (payload: OutboundPayload) => void;
  
  // 2. 渠道选择
  selectChannel: (target: DeliveryTarget) => ChannelAdapter;
  
  // 3. 消息分块
  chunk: (text: string, limit: number) => string[];
  
  // 4. 投递执行
  deliver: (chunks: string[], adapter: ChannelAdapter) => Promise<void>;
  
  // 5. 确认/重试
  ack: (messageId: string) => void;
  retry: (messageId: string, error: Error) => void;
};
```

---

## 5. 工作流程

### 5.1 系统启动流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      System Startup Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. CLI 入口                                                    │
│     openclaw gateway --port 18789                               │
│         │                                                       │
│         ▼                                                       │
│  2. 加载配置                                                    │
│     loadConfig() → 读取 ~/.openclaw/config.json                 │
│         │                                                       │
│         ▼                                                       │
│  3. 初始化插件                                                  │
│     loadOpenClawPlugins() → 加载 extensions/                    │
│         │                                                       │
│         ▼                                                       │
│  4. 启动 WebSocket 服务器                                       │
│     createWebSocketServer() → ws://127.0.0.1:18789              │
│         │                                                       │
│         ▼                                                       │
│  5. 启动渠道                                                    │
│     startChannels() → 连接 Telegram/WhatsApp/etc.               │
│         │                                                       │
│         ▼                                                       │
│  6. 启动辅助服务                                                │
│     ├── Browser Control Server                                  │
│     ├── Gmail Watcher                                           │
│     ├── Cron Scheduler                                          │
│     └── Memory Backend                                          │
│         │                                                       │
│         ▼                                                       │
│  7. 注册守护进程 (可选)                                         │
│     installDaemon() → launchd / systemd                         │
│         │                                                       │
│         ▼                                                       │
│  8. 就绪                                                        │
│     Gateway listening on ws://127.0.0.1:18789                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 消息处理流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    Message Processing Flow                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  用户发送消息 (WhatsApp/Telegram/etc.)                          │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Channel Plugin 接收                                   │   │
│  │    - 接收原始消息                                        │   │
│  │    - 解析发送者信息                                      │   │
│  │    - 提取消息内容                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. 消息标准化                                            │   │
│  │    - 统一消息格式                                        │   │
│  │    - 处理媒体附件                                        │   │
│  │    - 解析回复引用                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 3. 安全检查                                              │   │
│  │    - DM Pairing 验证                                     │   │
│  │    - Allowlist 检查                                      │   │
│  │    - Rate Limiting                                       │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 4. Gateway 路由                                          │   │
│  │    - 确定 Agent ID                                       │   │
│  │    - 确定 Session Key                                    │   │
│  │    - 加载会话上下文                                      │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 5. Agent 处理                                            │   │
│  │    - 构建系统提示                                        │   │
│  │    - 加载工具目录                                        │   │
│  │    - 调用 LLM                                            │   │
│  │    - 流式处理响应                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 6. 工具调用 (可选)                                       │   │
│  │    - 检查工具权限                                        │   │
│  │    - 沙箱执行                                            │   │
│  │    - 返回结果                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 7. 响应生成                                              │   │
│  │    - 文本分块                                            │   │
│  │    - 格式转换                                            │   │
│  │    - 媒体处理                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 8. 消息投递                                              │   │
│  │    - 选择渠道适配器                                      │   │
│  │    - 发送消息块                                          │   │
│  │    - 处理投递确认                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  用户收到回复                                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 Agent 执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Execution Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  chat.send 请求                                                 │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 请求验证                                              │   │
│  │    - Schema 验证                                         │   │
│  │    - 权限检查                                            │   │
│  │    - 参数规范化                                          │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. 会话准备                                              │   │
│  │    - 加载会话历史                                        │   │
│  │    - 构建上下文                                          │   │
│  │    - 解析模型配置                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 3. 工具准备                                              │   │
│  │    - 加载工具目录                                        │   │
│  │    - 应用工具策略                                        │   │
│  │    - 注入沙箱配置                                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 4. LLM 调用                                              │   │
│  │    - 构建请求                                            │   │
│  │    - 流式响应                                            │   │
│  │    - 事件广播                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 5. 工具执行循环                                          │   │
│  │    ┌─────────────────────────────────────────────┐      │   │
│  │    │ while (response.toolCalls) {                │      │   │
│  │    │   for (toolCall of toolCalls) {             │      │   │
│  │    │     1. 检查权限                             │      │   │
│  │    │     2. 执行工具                             │      │   │
│  │    │     3. 返回结果                             │      │   │
│  │    │     4. 追加到上下文                         │      │   │
│  │    │   }                                         │      │   │
│  │    │   response = await llm.continue()           │      │   │
│  │    │ }                                           │      │   │
│  │    └─────────────────────────────────────────────┘      │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 6. 响应处理                                              │   │
│  │    - 保存会话历史                                        │   │
│  │    - 触发钩子                                            │   │
│  │    - 返回结果                                            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 定时任务流程

```
┌─────────────────────────────────────────────────────────────────┐
│                       Cron Job Flow                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Cron 配置                                                      │
│  {                                                              │
│    "id": "morning-briefing",                                    │
│    "schedule": "0 9 * * *",                                     │
│    "action": "agent",                                           │
│    "params": {                                                  │
│      "message": "今日简报",                                     │
│      "deliverTo": "telegram:123456"                             │
│    }                                                            │
│  }                                                              │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 调度器                                                │   │
│  │    - 解析 cron 表达式                                    │   │
│  │    - 计算下次执行时间                                    │   │
│  │    - 设置定时器                                          │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. 任务执行                                              │   │
│  │    - 获取分布式锁                                        │   │
│  │    - 记录执行日志                                        │   │
│  │    - 执行动作                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 3. Agent 调用                                            │   │
│  │    - 创建隔离会话                                        │   │
│  │    - 执行 Agent                                          │   │
│  │    - 收集响应                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 4. 结果投递                                              │   │
│  │    - 解析投递目标                                        │   │
│  │    - 选择渠道适配器                                      │   │
│  │    - 发送消息                                            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. 数据流

### 6.1 会话数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                       Session Data Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ~/.openclaw/                                                   │
│  ├── config.json              # 主配置文件                      │
│  ├── sessions/                # 会话存储                        │
│  │   ├── main/                # 主会话                         │
│  │   │   └── transcript.jsonl # 会话记录                       │
│  │   └── <session-key>/       # 其他会话                       │
│  │       └── transcript.jsonl                                  │
│  ├── agents/                  # Agent 配置                     │
│  │   └── <agent-id>/                                           │
│  │       ├── config.json                                       │
│  │       └── sessions/                                         │
│  ├── secrets/                 # 密钥存储                       │
│  │   └── <secret-id>.json                                      │
│  ├── cron/                    # 定时任务                       │
│  │   └── jobs.json                                             │
│  └── plugins/                 # 插件数据                       │
│      └── <plugin-id>/                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 消息数据结构

```typescript
// 入站消息
type InboundMessage = {
  id: string;
  channel: ChannelId;
  sender: {
    id: string;
    name?: string;
    number?: string;
  };
  content: {
    text?: string;
    media?: MediaAttachment[];
  };
  metadata: {
    timestamp: number;
    replyTo?: string;
    chatId?: string;
    threadId?: string;
  };
};

// 出站消息
type OutboundMessage = {
  id: string;
  channel: ChannelId;
  target: {
    to: string;
    chatId?: string;
    threadId?: string;
  };
  content: {
    text?: string;
    media?: MediaAttachment[];
    replyTo?: string;
  };
  delivery: {
    status: 'pending' | 'sent' | 'delivered' | 'failed';
    messageId?: string;
    timestamp?: number;
    error?: string;
  };
};
```

### 6.3 WebSocket 消息格式

```typescript
// 请求
type GatewayRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

// 响应
type GatewayResponse = {
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

// 事件
type GatewayEvent = {
  type: string;
  data: unknown;
};
```

---

## 7. 插件系统

### 7.1 插件架构

```
┌─────────────────────────────────────────────────────────────────┐
│                       Plugin Architecture                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Plugin Loader                         │   │
│  │  - 发现插件 (extensions/, npm packages)                  │   │
│  │  - 加载清单 (openclaw.plugin.json)                       │   │
│  │  - 验证 Schema                                           │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Plugin Runtime                         │   │
│  │  - 生命周期管理                                          │   │
│  │  - 依赖注入                                              │   │
│  │  - 钩子注册                                              │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Plugin Registry                        │   │
│  │  - 插件元数据                                            │   │
│  │  - 导出接口                                              │   │
│  │  - 状态管理                                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 插件类型

| 类型 | 用途 | 示例 |
|------|------|------|
| **Channel** | 消息渠道集成 | discord, slack, telegram |
| **Auth** | 认证提供者 | google-gemini-cli-auth |
| **Tool** | 工具扩展 | browser, diffs, lobster |
| **Memory** | 记忆存储 | memory-core, memory-lancedb |
| **Diagnostic** | 诊断监控 | diagnostics-otel |

### 7.3 插件清单

```json
// openclaw.plugin.json
{
  "name": "discord",
  "version": "1.0.0",
  "type": "channel",
  "provides": {
    "channel": {
      "id": "discord",
      "inbound": true,
      "outbound": true,
      "actions": true
    }
  },
  "hooks": [
    "message.received",
    "message.sent",
    "channel.connected"
  ],
  "config": {
    "schema": "./config-schema.json"
  }
}
```

### 7.4 插件开发

```typescript
// 插件入口
import type { OpenClawPluginDefinition } from 'openclaw/plugin-sdk';

export default {
  name: 'my-plugin',
  
  // 初始化
  async initialize(context) {
    // 注册钩子
    context.hooks.on('message.received', handleMessage);
    
    // 注册工具
    context.tools.register('my_tool', {
      description: 'My custom tool',
      parameters: { /* ... */ },
      execute: async (params) => { /* ... */ }
    });
    
    // 注册渠道
    context.channels.register({
      id: 'my-channel',
      inbound: { /* ... */ },
      outbound: { /* ... */ }
    });
  },
  
  // 清理
  async teardown() {
    // 清理资源
  }
} satisfies OpenClawPluginDefinition;
```

---

## 8. 安全架构

### 8.1 安全层次

```
┌─────────────────────────────────────────────────────────────────┐
│                      Security Architecture                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: 网络安全                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  • SSRF 防护 (禁止访问内网 IP)                           │   │
│  │  • Origin 检查 (防止 CSRF)                               │   │
│  │  • Rate Limiting (防止滥用)                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 2: 认证授权                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  • Device Auth (设备认证)                                │   │
│  │  • Connection Auth (连接认证)                            │   │
│  │  • Method Scopes (方法权限)                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 3: 消息安全                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  • DM Pairing (消息配对验证)                             │   │
│  │  • Allowlist (白名单)                                    │   │
│  │  • Input Sanitization (输入净化)                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 4: 执行安全                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  • Exec Approval (命令执行审批)                          │   │
│  │  • Safe Bin Policy (安全二进制策略)                      │   │
│  │  • Sandbox Isolation (沙箱隔离)                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Layer 5: 数据安全                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  • Secret Management (密钥管理)                          │   │
│  │  • File Boundary (文件边界)                              │   │
│  │  • Audit Logging (审计日志)                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 DM Pairing（消息配对）

```
┌─────────────────────────────────────────────────────────────────┐
│                       DM Pairing Flow                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  未知用户发送消息                                                │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 检查 dmPolicy                                           │   │
│  │ - "pairing": 需要配对                                   │   │
│  │ - "open": 允许所有                                      │   │
│  │ - "closed": 拒绝所有                                    │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│         ┌─────────────────┴─────────────────┐                  │
│         │                                   │                   │
│         ▼ pairing                          ▼ open/closed        │
│  ┌─────────────────┐               ┌─────────────────┐         │
│  │ 生成配对码      │               │ 直接处理/拒绝   │         │
│  │ 返回配对提示    │               └─────────────────┘         │
│  └────────┬────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │ 管理员审批      │                                           │
│  │ openclaw        │                                           │
│  │ pairing approve │                                           │
│  │ telegram XXXX   │                                           │
│  └────────┬────────┘                                           │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │ 添加到白名单    │                                           │
│  │ 后续消息放行    │                                           │
│  └─────────────────┘                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Exec Approval（命令执行审批）

```
┌─────────────────────────────────────────────────────────────────┐
│                     Exec Approval Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Agent 请求执行命令                                             │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 命令分析                                              │   │
│  │    - 解析命令                                            │   │
│  │    - 识别风险级别                                        │   │
│  │    - 检查混淆                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. 策略匹配                                              │   │
│  │    - Safe Bin 检查                                       │   │
│  │    - Allowlist 匹配                                      │   │
│  │    - 模式匹配                                            │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│         ┌─────────────────┼─────────────────┐                  │
│         │                 │                 │                   │
│         ▼ safe           ▼ ask             ▼ deny               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ 直接执行    │  │ 请求审批    │  │ 拒绝执行    │             │
│  └─────────────┘  └──────┬──────┘  └─────────────┘             │
│                          │                                      │
│                          ▼                                      │
│                   ┌─────────────────────────────────────┐      │
│                   │ 发送审批请求到用户                   │      │
│                   │ [Allow] [Deny] [Allow Always]       │      │
│                   └──────────────┬──────────────────────┘      │
│                                  │                              │
│                    ┌─────────────┼─────────────┐               │
│                    │             │             │                │
│                    ▼ allow      ▼ deny        ▼ always          │
│             ┌───────────┐ ┌───────────┐ ┌───────────────┐      │
│             │ 执行命令  │ │ 拒绝      │ │ 执行 + 添加到 │      │
│             └───────────┘ └───────────┘ │ Allowlist     │      │
│                                         └───────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. 部署架构

### 9.1 本地部署

```
┌─────────────────────────────────────────────────────────────────┐
│                      Local Deployment                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    User Machine                          │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              Gateway (Daemon)                    │    │   │
│  │  │           ws://127.0.0.1:18789                   │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                          │                               │   │
│  │         ┌────────────────┼────────────────┐             │   │
│  │         │                │                │              │   │
│  │         ▼                ▼                ▼              │   │
│  │  ┌───────────┐   ┌───────────┐   ┌───────────────┐      │   │
│  │  │    CLI    │   │ macOS App │   │ WebChat/Control│     │   │
│  │  └───────────┘   └───────────┘   └───────────────┘      │   │
│  │                                                          │   │
│  │  ~/.openclaw/                                            │   │
│  │  ├── config.json                                         │   │
│  │  ├── sessions/                                           │   │
│  │  └── secrets/                                            │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 远程部署

```
┌─────────────────────────────────────────────────────────────────┐
│                     Remote Deployment                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Cloud Server                           │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              Gateway (Docker)                    │    │   │
│  │  │           ws://0.0.0.0:18789                     │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                          │                               │   │
│  │                          ▼                               │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │         Tailscale / SSH Tunnel                   │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ Secure Tunnel                    │
│                              │                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Client Devices                         │   │
│  │                                                          │   │
│  │  ┌───────────┐   ┌───────────┐   ┌───────────────┐      │   │
│  │  │ iOS App   │   │Android App│   │     CLI       │      │   │
│  │  └───────────┘   └───────────┘   └───────────────┘      │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 Docker 部署

```yaml
# docker-compose.yml
version: '3.8'
services:
  openclaw:
    image: openclaw/openclaw:latest
    ports:
      - "18789:18789"
    volumes:
      - ./data:/root/.openclaw
    environment:
      - NODE_ENV=production
    restart: unless-stopped
```

---

## 10. 扩展指南

### 10.1 添加新渠道

1. **创建插件目录**

```bash
mkdir -p extensions/my-channel
cd extensions/my-channel
```

2. **创建插件清单**

```json
// openclaw.plugin.json
{
  "name": "my-channel",
  "version": "1.0.0",
  "type": "channel",
  "provides": {
    "channel": {
      "id": "my-channel",
      "inbound": true,
      "outbound": true
    }
  }
}
```

3. **实现渠道适配器**

```typescript
// src/channel.ts
import type { ChannelOutboundAdapter } from 'openclaw/plugin-sdk';

export const outboundAdapter: ChannelOutboundAdapter = {
  channel: 'my-channel',
  
  async send(params) {
    // 实现发送逻辑
  },
  
  async sendMedia(params) {
    // 实现媒体发送逻辑
  }
};
```

4. **注册插件**

```typescript
// index.ts
import { outboundAdapter } from './src/channel.js';

export default {
  name: 'my-channel',
  
  async initialize(context) {
    context.channels.register(outboundAdapter);
  }
};
```

### 10.2 添加新工具

```typescript
// 在插件中注册工具
context.tools.register('my_tool', {
  name: 'my_tool',
  description: 'My custom tool',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string' }
    },
    required: ['input']
  },
  
  async execute(params, context) {
    // 实现工具逻辑
    return { result: 'success' };
  }
});
```

### 10.3 添加新技能

1. **创建技能目录**

```bash
mkdir -p skills/my-skill
```

2. **创建技能清单**

```markdown
# SKILL.md

---
name: my-skill
description: My custom skill
triggers:
  - "my-skill"
  - "myskill"
---

## 功能描述

这个技能用于...

## 使用方法

用户可以通过以下方式触发...
```

3. **实现技能逻辑**

技能通过 Agent 的工具系统实现，无需额外注册。

---

## 附录

### A. 关键文件索引

| 文件 | 描述 |
|------|------|
| `src/gateway/server-http.ts` | HTTP 服务器入口 |
| `src/gateway/server-methods/chat.ts` | 聊天处理核心 |
| `src/agents/cli-runner.ts` | Agent 运行器 |
| `src/channels/plugins/outbound/load.ts` | 渠道适配器加载 |
| `src/infra/outbound/deliver.ts` | 消息投递核心 |
| `src/plugins/loader.ts` | 插件加载器 |
| `src/config/config.ts` | 配置加载 |

### B. 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `OPENCLAW_PORT` | Gateway 端口 | 18789 |
| `OPENCLAW_CONFIG` | 配置文件路径 | ~/.openclaw/config.json |
| `OPENCLAW_STATE_DIR` | 状态目录 | ~/.openclaw |
| `OPENCLAW_LOG_LEVEL` | 日志级别 | info |

### C. 常用命令

```bash
# 启动 Gateway
openclaw gateway --port 18789 --verbose

# 与 Agent 对话
openclaw agent --message "Hello"

# 运行诊断
openclaw doctor

# 查看配置
openclaw config get

# 管理定时任务
openclaw cron list
openclaw cron add "0 9 * * *" --message "Morning briefing"

# 管理技能
openclaw skills list
openclaw skills install github
```

---

*文档版本: 2026.3.14*
*基于 OpenClaw v2026.3.13*
