# OpenClaw 用户输入处理流程

## 概述

当用户输入 prompt 后，OpenClaw 会经过一系列处理步骤将消息转化为 AI 响应。本文档详细描述这个流程。

## 整体流程图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        User Input Processing Pipeline                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  用户输入 prompt                                                                │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  1. Gateway RPC 入口 (chat.send)                                        │   │
│  │     - 参数验证                                                          │   │
│  │     - 消息清洗 (sanitize)                                               │   │
│  │     - 附件解析                                                          │   │
│  │     - 会话加载 (loadSessionEntry)                                       │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  2. 消息分发 (dispatchInboundMessage)                                   │   │
│  │     - 构建消息上下文 (MsgContext)                                        │   │
│  │     - 路由解析                                                          │   │
│  │     - 创建回复分发器                                                    │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  3. 会话解析与上下文构建                                                 │   │
│  │     - 解析 sessionKey                                                   │   │
│  │     - 解析 agentId                                                      │   │
│  │     - 解析工作目录 (workspaceDir)                                        │   │
│  │     - 加载会话配置                                                      │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  4. Hook 执行阶段                                                       │   │
│  │     - before_model_resolve (模型解析前)                                 │   │
│  │     - before_prompt_build (提示构建前)                                  │   │
│  │     - before_agent_start (Agent 启动前)                                 │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  5. Agent 运行 (runReplyAgent)                                          │   │
│  │     - 队列管理 (queue)                                                  │   │
│  │     - 模型选择                                                          │   │
│  │     - 记忆刷新 (memory flush)                                           │   │
│  │     - 执行 Agent Turn                                                   │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  6. 工具执行 (Tool Execution)                                           │   │
│  │     - before_tool_call hook                                             │   │
│  │     - 工具调用                                                          │   │
│  │     - after_tool_call hook                                              │   │
│  │     - 结果持久化                                                        │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  7. 响应构建与返回                                                       │   │
│  │     - 构建 ReplyPayload                                                 │   │
│  │     - 流式输出                                                          │   │
│  │     - 广播响应                                                          │   │
│  │     - 持久化会话                                                        │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 阶段详解

### 1. Gateway RPC 入口 (`chat.send`)

**文件位置：** `src/gateway/server-methods/chat.ts`

```typescript
"chat.send": async ({ params, respond, context, client }) => {
  // 1. 参数验证
  if (!validateChatSendParams(params)) { ... }
  
  // 2. 消息清洗
  const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
  
  // 3. 附件解析
  const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments);
  
  // 4. 会话加载
  const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
  
  // 5. 幂等性检查
  const cached = context.dedupe.get(`chat:${clientRunId}`);
  
  // 6. 创建 AbortController
  context.chatAbortControllers.set(clientRunId, { ... });
}
```

**关键操作：**
| 操作 | 说明 |
|------|------|
| 参数验证 | 验证 `sessionKey`、`message`、`attachments` 等参数 |
| 消息清洗 | 移除控制字符、规范化 Unicode |
| 附件解析 | 解析图片、文件等附件 |
| 会话加载 | 从 `sessionStore` 加载会话状态 |
| 幂等性检查 | 通过 `idempotencyKey` 防止重复处理 |

---

### 2. 消息分发 (`dispatchInboundMessage`)

**文件位置：** `src/auto-reply/dispatch.ts`

```typescript
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () => dispatchReplyFromConfig({ ... }),
  });
}
```

**消息上下文 (`MsgContext`)：**
```typescript
const ctx: MsgContext = {
  Body: messageForAgent,           // 原始消息
  BodyForAgent: stampedMessage,    // 带时间戳的消息
  BodyForCommands: commandBody,    // 命令体
  RawBody: parsedMessage,          // 原始消息
  CommandBody: commandBody,        // 命令体
  SessionKey: sessionKey,          // 会话标识
  Provider: INTERNAL_MESSAGE_CHANNEL,
  Surface: INTERNAL_MESSAGE_CHANNEL,
  OriginatingChannel: originatingChannel,
  OriginatingTo: originatingTo,
  AccountId: accountId,
  MessageThreadId: messageThreadId,
  ChatType: "direct",
  CommandAuthorized: true,
  MessageSid: clientRunId,
  SenderId: clientInfo?.id,
  SenderName: clientInfo?.displayName,
};
```

---

### 3. 会话解析与上下文构建

**文件位置：** `src/agents/workspace-run.ts`

```typescript
export function resolveRunWorkspaceDir(params: {
  workspaceDir: unknown;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): ResolveRunWorkspaceResult {
  // 1. 解析 agentId
  const { agentId, agentIdSource } = resolveRunAgentId({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  
  // 2. 解析工作目录
  const fallbackWorkspace = resolveAgentWorkspaceDir(params.config ?? {}, agentId);
  
  return {
    workspaceDir: resolveUserPath(sanitizedFallback),
    usedFallback: true,
    fallbackReason,
    agentId,
    agentIdSource,
  };
}
```

**Session Key 解析：**
```
格式: agent:<agentId>:<scope>:<identifier>
示例: agent:main:telegram:group:123456
```

---

### 4. Hook 执行阶段

**文件位置：** `src/plugins/hooks.ts`

OpenClaw 有两个 Hook 系统：

#### 4.1 内部 Hooks (Gateway Hooks)

| Hook | 触发时机 | 用途 |
|------|----------|------|
| `agent:bootstrap` | 系统提示构建前 | 添加/移除启动上下文文件 |
| `/new` | 新会话时 | 会话重置事件 |
| `/reset` | 重置会话时 | 清理会话状态 |
| `/stop` | 停止运行时 | 中止当前运行 |

#### 4.2 插件 Hooks (Plugin Hooks)

| Hook | 触发时机 | 返回值 | 用途 |
|------|----------|--------|------|
| `before_model_resolve` | 模型解析前 | `{ modelOverride, providerOverride }` | 覆盖模型/提供者 |
| `before_prompt_build` | 提示构建前 | `{ prependContext, systemPrompt }` | 注入上下文 |
| `before_agent_start` | Agent 启动前 | 兼容性 hook | 模型+上下文覆盖 |
| `llm_input` | LLM 输入时 | 无 | 观察 LLM 输入 |
| `llm_output` | LLM 输出时 | 无 | 观察 LLM 输出 |
| `before_tool_call` | 工具调用前 | `{ params, block, blockReason }` | 修改/阻止工具调用 |
| `after_tool_call` | 工具调用后 | 无 | 观察工具结果 |
| `tool_result_persist` | 结果持久化前 | `{ message }` | 修改持久化内容 |
| `before_compaction` | 压缩前 | 无 | 观察压缩事件 |
| `after_compaction` | 压缩后 | 无 | 观察压缩结果 |
| `agent_end` | Agent 结束后 | 无 | 分析完成对话 |
| `before_reset` | 会话重置前 | 无 | 保存重要信息 |
| `message_received` | 收到消息时 | 无 | 处理入站消息 |
| `message_sending` | 发送消息前 | `{ content, cancel }` | 修改/取消出站消息 |
| `message_sent` | 发送消息后 | 无 | 记录发送事件 |
| `session_start` | 会话开始时 | 无 | 会话初始化 |
| `session_end` | 会话结束时 | 无 | 会话清理 |
| `gateway_start` | Gateway 启动时 | 无 | Gateway 初始化 |
| `gateway_stop` | Gateway 停止时 | 无 | Gateway 清理 |

**Hook 执行顺序：**
```typescript
// 按优先级排序 (高优先级先执行)
const hooks = getHooksForName(registry, hookName)
  .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

// 修改型 hook 顺序执行
for (const hook of hooks) {
  const result = await hook.handler(event, ctx);
  if (result) {
    accumulatedResult = mergeResults(accumulatedResult, result);
  }
}

// 通知型 hook 并行执行
await Promise.all(hooks.map(hook => hook.handler(event, ctx)));
```

---

### 5. Agent 运行 (`runReplyAgent`)

**文件位置：** `src/auto-reply/reply/agent-runner.ts`

```typescript
export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  // ...
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  // 1. 队列策略判断
  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });
  
  // 2. 记忆刷新检查
  activeSessionEntry = await runMemoryFlushIfNeeded({ ... });
  
  // 3. 执行 Agent Turn
  const runOutcome = await runAgentTurnWithFallback({
    commandBody,
    followupRun,
    sessionCtx,
    opts,
    // ...
  });
  
  // 4. 构建响应
  const payloadResult = await buildReplyPayloads({ ... });
  
  return finalizeWithFollowup(finalPayloads, queueKey, runFollowupTurn);
}
```

**队列模式：**
| 模式 | 行为 |
|------|------|
| `drop` | 丢弃新请求 |
| `enqueue-followup` | 加入后续队列 |
| `run` | 立即执行 |

---

### 6. 工具执行

**文件位置：** `src/agents/openclaw-tools.ts`

**可用工具列表：**
```typescript
const tools: AnyAgentTool[] = [
  createBrowserTool({ ... }),      // 浏览器操作
  createCanvasTool({ ... }),       // 画布操作
  createNodesTool({ ... }),        // 节点操作
  createCronTool({ ... }),         // 定时任务
  createMessageTool({ ... }),      // 消息发送
  createTtsTool({ ... }),          // 语音合成
  createGatewayTool({ ... }),      // Gateway 管理
  createAgentsListTool({ ... }),   // Agent 列表
  createSessionsListTool({ ... }), // 会话列表
  createSessionsHistoryTool({ ... }), // 会话历史
  createSessionsSendTool({ ... }), // 会话发送
  createSessionsSpawnTool({ ... }), // 子 Agent 生成
  createWebSearchTool({ ... }),    // 网页搜索
  createWebFetchTool({ ... }),     // 网页抓取
  createImageTool({ ... }),        // 图像处理
  createPdfTool({ ... }),          // PDF 处理
  createSubagentsTool({ ... }),    // 子 Agent 管理
  // ... 插件工具
];
```

**工具执行流程：**
```
1. 模型决定调用工具
      │
      ▼
2. before_tool_call hook
      │
      ▼
3. 工具调用执行
      │
      ▼
4. after_tool_call hook
      │
      ▼
5. tool_result_persist hook
      │
      ▼
6. 结果返回给模型
```

---

### 7. 响应构建与返回

**响应载荷 (`ReplyPayload`)：**
```typescript
type ReplyPayload = {
  text?: string;           // 文本内容
  media?: MediaPayload[];  // 媒体内容
  isError?: boolean;       // 是否错误
  meta?: ReplyPayloadMeta; // 元数据
};
```

**响应流程：**
```typescript
// 1. 构建响应载荷
const { replyPayloads } = await buildReplyPayloads({
  payloads: payloadArray,
  isHeartbeat,
  blockStreamingEnabled,
  // ...
});

// 2. 广播最终响应
broadcastChatFinal({
  context,
  runId: clientRunId,
  sessionKey: rawSessionKey,
  message,
});

// 3. 持久化会话
await persistRunSessionUsage({
  storePath,
  sessionKey,
  usage,
  // ...
});
```

---

## 完整数据流

```
用户输入
    │
    ├─→ WebSocket/HTTP 请求
    │       │
    │       └─→ Gateway Server (chat.send)
    │               │
    │               ├─→ 参数验证 & 消息清洗
    │               │
    │               ├─→ 会话加载 (loadSessionEntry)
    │               │
    │               └─→ dispatchInboundMessage
    │                       │
    │                       ├─→ 构建 MsgContext
    │                       │
    │                       └─→ dispatchReplyFromConfig
    │                               │
    │                               ├─→ before_model_resolve hook
    │                               │
    │                               ├─→ 模型选择
    │                               │
    │                               ├─→ before_prompt_build hook
    │                               │
    │                               ├─→ 系统提示构建
    │                               │
    │                               ├─→ before_agent_start hook
    │                               │
    │                               └─→ runReplyAgent
    │                                       │
    │                                       ├─→ 队列管理
    │                                       │
    │                                       ├─→ 记忆刷新检查
    │                                       │
    │                                       └─→ runAgentTurnWithFallback
    │                                               │
    │                                               ├─→ LLM 推理
    │                                               │       │
    │                                               │       ├─→ llm_input hook
    │                                               │       │
    │                                               │       └─→ llm_output hook
    │                                               │
    │                                               ├─→ 工具调用循环
    │                                               │       │
    │                                               │       ├─→ before_tool_call hook
    │                                               │       │
    │                                               │       ├─→ 执行工具
    │                                               │       │
    │                                               │       ├─→ after_tool_call hook
    │                                               │       │
    │                                               │       └─→ tool_result_persist hook
    │                                               │
    │                                               ├─→ 压缩检查
    │                                               │       │
    │                                               │       ├─→ before_compaction hook
    │                                               │       │
    │                                               │       └─→ after_compaction hook
    │                                               │
    │                                               └─→ agent_end hook
    │
    ├─→ 流式输出 (assistant delta events)
    │
    └─→ 最终响应 (chat final event)
            │
            ├─→ 持久化会话
            │
            └─→ 广播响应
```

---

## 关键文件索引

| 文件路径 | 功能 |
|----------|------|
| `src/gateway/server-methods/chat.ts` | Gateway RPC 处理入口 |
| `src/auto-reply/dispatch.ts` | 消息分发逻辑 |
| `src/auto-reply/reply/agent-runner.ts` | Agent 运行主逻辑 |
| `src/auto-reply/reply/dispatch-from-config.ts` | 配置驱动的回复分发 |
| `src/agents/workspace-run.ts` | 工作目录解析 |
| `src/plugins/hooks.ts` | Hook 执行器 |
| `src/agents/openclaw-tools.ts` | 工具定义 |
| `src/commands/agent.ts` | CLI agent 命令 |
| `src/gateway/server-methods/agent-job.ts` | Agent 任务管理 |

---

## 配置参考

```typescript
// ~/.openclaw/config.json
{
  "agents": {
    "defaults": {
      "model": "claude-3-5-sonnet-20241022",
      "timeoutSeconds": 600,
      "contextTokens": 128000,
      "thinkingDefault": "auto",
      "verboseDefault": "off"
    }
  },
  "session": {
    "mainKey": "main",
    "store": "~/.openclaw/sessions.json"
  },
  "plugins": {
    "enabled": ["memory-lancedb"]
  }
}
```

---

## 总结

用户输入 prompt 后的处理流程可以概括为：

1. **入口处理** - Gateway 接收请求，验证参数，清洗消息
2. **上下文构建** - 解析会话、Agent、工作目录
3. **Hook 注入** - 执行插件钩子，允许自定义行为
4. **Agent 运行** - 模型推理、工具调用、记忆管理
5. **响应返回** - 流式输出、持久化、广播

这个架构的核心特点是：
- **模块化** - 各阶段职责清晰，易于扩展
- **Hook 驱动** - 通过 Hook 系统实现高度可定制
- **异步流式** - 支持实时响应输出
- **队列管理** - 防止并发冲突，保证会话一致性
