# OpenClaw Agent 工作流程分析

## 目录

1. [整体架构](#1-整体架构)
2. [核心执行流程](#2-核心执行流程)
3. [上下文构建机制](#3-上下文构建机制)
4. [Hook 注入系统](#4-hook-注入系统)
5. [工具执行流程](#5-工具执行流程)
6. [错误处理与重试机制](#6-错误处理与重试机制)
7. [认证与配置管理](#7-认证与配置管理)
8. [核心文件索引](#8-核心文件索引)

---

## 1. 整体架构

### 1.1 架构全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent 执行架构                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  Gateway 控制平面                             ││
│  │         WebSocket Server (ws://127.0.0.1:18789)             ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │          Agent 运行时 (runEmbeddedPiAgent)                   ││
│  │  ┌────────────────────────────────────────────────────────┐ ││
│  │  │  1. 会话解析与准备                                      │ ││
│  │  │     - 解析 sessionKey、agentId                          │ ││
│  │  │     - 加载会话历史                                      │ ││
│  │  │     - 确定工作目录                                      │ ││
│  │  └────────────────────────────────────────────────────────┘ ││
│  │  ┌────────────────────────────────────────────────────────┐ ││
│  │  │  2. Hook 执行阶段                                       │ ││
│  │  │     - before_model_resolve: 模型选择前                  │ ││
│  │  │     - before_prompt_build: 系统提示构建前               │ ││
│  │  │     - before_agent_start: Agent 启动前                  │ ││
│  │  └────────────────────────────────────────────────────────┘ ││
│  │  ┌────────────────────────────────────────────────────────┐ ││
│  │  │  3. 上下文构建                                          │ ││
│  │  │     - 系统提示构建 (buildAgentSystemPrompt)              │ ││
│  │  │     - Bootstrap 文件注入                                │ ││
│  │  │     - 工具目录加载                                      │ ││
│  │  └────────────────────────────────────────────────────────┘ ││
│  │  ┌────────────────────────────────────────────────────────┐ ││
│  │  │  4. Agent 执行                                          │ ││
│  │  │     - 创建 AgentSession                                │ ││
│  │  │     - 注入工具定义                                      │ ││
│  │  │     - 执行 LLM 推理                                     │ ││
│  │  └────────────────────────────────────────────────────────┘ ││
│  │  ┌────────────────────────────────────────────────────────┐ ││
│  │  │  5. 工具调用循环                                        │ ││
│  │  │     - 检查工具权限                                      │ ││
│  │  │     - 沙箱执行                                          │ ││
│  │  │     - 结果持久化                                        │ ││
│  │  └────────────────────────────────────────────────────────┘ ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              LLM Provider (API 调用)                         ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   ││
│  │  │ OpenAI   │  │ Anthropic│  │ Gemini   │  │ 本地模型  │   ││
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心依赖关系

```
runEmbeddedPiAgent (主入口)
    │
    ├── resolveModel() - 模型解析
    │   └── model-registry.ts
    │
    ├── runEmbeddedAttempt() - 单次执行尝试
    │   ├── buildAgentSystemPrompt() - 系统提示构建
    │   ├── AgentSession.create() - 创建会话
    │   └── tool execution - 工具执行
    │
    ├── contextEngine.compact() - 上下文压缩
    │   └── context-engine/*.ts
    │
    └── Hook 系统
        ├── before_model_resolve
        ├── before_prompt_build
        └── before_agent_start
```

---

## 2. 核心执行流程

### 2.1 主入口函数：`runEmbeddedPiAgent`

**位置**: `src/agents/pi-embedded-runner/run.ts`

**函数签名**:
```typescript
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams
): Promise<EmbeddedPiRunResult>
```

**执行阶段**:

```
┌─────────────────────────────────────────────────────────────────┐
│                runEmbeddedPiAgent 执行流程                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. 初始化阶段                                                    │
│     ├── 解析 sessionKey、sessionId、agentId                      │
│     ├── 确定工作目录 (resolveRunWorkspaceDir)                    │
│     ├── 加载配置 (ensureOpenClawModelsJson)                      │
│     └── 初始化运行时插件 (ensureRuntimePluginsLoaded)            │
│                                                                   │
│  2. 模型解析阶段                                                  │
│     ├── 执行 before_model_resolve hook                           │
│     ├── 执行 before_agent_start hook (legacy)                    │
│     ├── 解析模型配置 (resolveModel)                               │
│     ├── 检查上下文窗口限制                                        │
│     └── 准备认证配置 (ensureAuthProfileStore)                    │
│                                                                   │
│  3. 认证配置阶段                                                  │
│     ├── 解析认证配置文件顺序 (resolveAuthProfileOrder)           │
│     ├── 检查冷却状态 (isProfileInCooldown)                       │
│     ├── 获取 API Key (getApiKeyForModel)                         │
│     └── 设置运行时认证 (authStorage.setRuntimeApiKey)            │
│                                                                   │
│  4. 主执行循环                                                    │
│     └── while (true) { ... }                                     │
│         ├── 检查重试限制                                          │
│         ├── 调用 runEmbeddedAttempt                              │
│         ├── 处理上下文溢出                                        │
│         ├── 处理认证失败                                          │
│         ├── 处理速率限制                                          │
│         └── 处理超时                                              │
│                                                                   │
│  5. 结果返回阶段                                                  │
│     ├── 构建 agentMeta (usage, provider, model)                  │
│     ├── 构建 payloads (文本、工具结果)                            │
│     └── 返回 EmbeddedPiRunResult                                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 单次执行尝试：`runEmbeddedAttempt`

**位置**: `src/agents/pi-embedded-runner/run/attempt.ts`

**执行流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   runEmbeddedAttempt 执行流程                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. 会话准备                                                      │
│     ├── 加载或创建会话文件                                        │
│     ├── 加载历史消息                                              │
│     └── 初始化上下文引擎                                          │
│                                                                   │
│  2. 工具准备                                                      │
│     ├── 加载工具目录 (createToolCatalog)                         │
│     ├── 应用工具策略                                              │
│     └── 注入沙箱配置                                              │
│                                                                   │
│  3. 系统提示构建                                                  │
│     ├── 执行 before_prompt_build hook                            │
│     ├── 构建 skills section                                      │
│     ├── 构建 memory section                                      │
│     ├── 构建 messaging section                                   │
│     ├── 构建 tooling section                                     │
│     ├── 构建 runtime section                                     │
│     └── 构建 workspace section                                   │
│                                                                   │
│  4. Bootstrap 注入                                                │
│     ├── 解析 bootstrap 文件 (resolveBootstrapContextForRun)      │
│     ├── 分析预算 (analyzeBootstrapBudget)                        │
│     └── 注入到上下文                                              │
│                                                                   │
│  5. Agent 执行                                                    │
│     ├── 创建 AgentSession                                        │
│     ├── 设置系统提示                                              │
│     ├── 注入用户消息                                              │
│     └── 执行 LLM 推理                                             │
│                                                                   │
│  6. 工具调用处理                                                  │
│     └── while (response.toolCalls) { ... }                       │
│         ├── 检查权限                                              │
│         ├── 执行 before_tool_call hook                           │
│         ├── 沙箱执行                                              │
│         ├── 执行 after_tool_call hook                            │
│         ├── 持久化结果                                            │
│         └── 继续推理                                              │
│                                                                   │
│  7. 结果处理                                                      │
│     ├── 保存会话历史                                              │
│     ├── 触发 agent_end hook                                      │
│     └── 返回 attempt 结果                                         │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 上下文构建机制

### 3.1 系统提示构建

**核心函数**: `buildAgentSystemPrompt`

**位置**: `src/agents/system-prompt.ts`

**构建流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                  系统提示构建流程                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  buildAgentSystemPrompt(params)                                  │
│     │                                                             │
│     ├── 1. Skills Section (技能提示)                              │
│     │   ├── 指导 agent 如何使用技能系统                           │
│     │   ├── 包含 SKILL.md 的读取和使用规则                        │
│     │   └── 触发关键词和示例                                      │
│     │                                                             │
│     ├── 2. Memory Section (记忆召回)                              │
│     │   ├── 指导如何使用 memory_search 工具                       │
│     │   ├── 指导如何使用 memory_get 工具                          │
│     │   └── 记忆检索和更新规则                                    │
│     │                                                             │
│     ├── 3. Messaging Section (消息发送)                           │
│     │   ├── 指导如何使用 message 工具                             │
│     │   ├── channel 选择策略                                      │
│     │   ├── inline buttons 使用                                  │
│     │   └── 消息格式规范                                          │
│     │                                                             │
│     ├── 4. Tooling Section (工具摘要)                             │
│     │   ├── 可用工具列表                                          │
│     │   ├── 工具参数说明                                          │
│     │   └── 工具使用示例                                          │
│     │                                                             │
│     ├── 5. Runtime Section (运行时信息)                           │
│     │   ├── 当前时间                                              │
│     │   ├── 系统环境                                              │
│     │   └── 运行模式                                              │
│     │                                                             │
│     ├── 6. Workspace Section (工作目录)                           │
│     │   ├── 工作目录路径                                          │
│     │   ├── 目录结构                                              │
│     │   └── 文件操作约束                                          │
│     │                                                             │
│     └── 7. Documentation Section (文档路径)                       │
│         ├── 文档索引                                              │
│         ├── API 文档                                              │
│         └── 示例链接                                              │
│                                                                   │
│  返回完整的系统提示字符串                                         │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Bootstrap 上下文注入

**位置**: `src/agents/bootstrap-files.ts`

**注入流程**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Bootstrap 注入流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  resolveBootstrapContextForRun(params)                           │
│     │                                                             │
│     ├── 1. 解析工作目录                                           │
│     │   └── workspaceDir: ~/.openclaw/workspace/                 │
│     │                                                             │
│     ├── 2. 收集 Bootstrap 文件                                    │
│     │   ├── ~/.openclaw/workspace/MEMORY.md (长期记忆)           │
│     │   ├── ~/.openclaw/workspace/memory/YYYY-MM-DD.md (每日日志)│
│     │   └── Agent 目录下的自定义 bootstrap 文件                  │
│     │                                                             │
│     ├── 3. 分析预算                                               │
│     │   ├── maxChars: 最大字符数限制                              │
│     │   ├── 文件大小统计                                          │
│     │   └── 优先级排序                                            │
│     │                                                             │
│     ├── 4. 构建注入提示                                           │
│     │   ├── 文件路径标记                                          │
│     │   ├── 内容摘要                                              │
│     │   └── 注入统计信息                                          │
│     │                                                             │
│     └── 5. 返回 EmbeddedContextFile[]                             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**注入示例**:

```typescript
const bootstrapFiles: EmbeddedContextFile[] = [
  {
    path: "~/.openclaw/workspace/MEMORY.md",
    content: "# 长期记忆\n\n- 用户偏好设置...\n- 重要事件记录...",
    lineCount: 150,
    charCount: 3500
  },
  {
    path: "~/.openclaw/workspace/memory/2026-03-25.md",
    content: "# 2026-03-25 日志\n\n## 完成的任务\n- ...",
    lineCount: 50,
    charCount: 1200
  }
];
```

### 3.3 动态上下文加载

**通过工具系统实现**:

```typescript
// 1. memory_search - 向量搜索
{
  name: "memory_search",
  description: "按语义向量搜索相关记忆",
  parameters: {
    query: "string",  // 搜索查询
    limit: "number"   // 返回数量
  }
}

// 2. memory_get - 获取特定记忆
{
  name: "memory_get",
  description: "获取指定 ID 的记忆",
  parameters: {
    id: "string"  // 记忆 ID
  }
}

// 3. read_file - 读取文件上下文
{
  name: "read_file",
  description: "读取文件内容",
  parameters: {
    filePath: "string",
    limit: "number?",
    offset: "number?"
  }
}
```

---

## 4. Hook 注入系统

### 4.1 Hook 类型定义

**位置**: `src/plugins/types.ts`

```typescript
// Hook 类型枚举
type PluginHookName =
  | "before_model_resolve"      // 模型解析前
  | "before_prompt_build"       // 系统提示构建前
  | "before_agent_start"        // Agent 启动前
  | "before_tool_call"          // 工具调用前
  | "after_tool_call"           // 工具调用后
  | "tool_result_persist"       // 工具结果持久化
  | "agent_end"                 // Agent 结束
  | "before_compaction"         // 上下文压缩前
  | "after_compaction";         // 上下文压缩后
```

### 4.2 Hook 执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      Hook 执行流程                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Agent 生命周期                                                   │
│     │                                                             │
│     ├── before_model_resolve                                     │
│     │   ├── 输入: { prompt }                                     │
│     │   ├── 输出: { providerOverride?, modelOverride? }         │
│     │   └── 用途: 动态选择模型                                    │
│     │                                                             │
│     ├── before_prompt_build                                      │
│     │   ├── 输入: { defaultPrompt }                              │
│     │   ├── 输出: {                                              │
│     │   │     systemPrompt?,        // 完全覆盖系统提示          │
│     │   │     prependContext?,      // 在系统提示前追加          │
│     │   │     prependSystemContext? // 在系统 section 前追加     │
│     │   │   }                                                     │
│     │   └── 用途: 注入自定义上下文                                │
│     │                                                             │
│     ├── before_agent_start                                       │
│     │   ├── 输入: { prompt }                                     │
│     │   ├── 输出: {                                              │
│     │   │     providerOverride?,                                 │
│     │   │     modelOverride?,                                    │
│     │   │     prependContext?,                                   │
│     │   │     systemPrompt?                                      │
│     │   │   }                                                     │
│     │   └── 用途: 兼容性 hook (before_prompt_build 的旧版本)     │
│     │                                                             │
│     ├── [Agent 执行中]                                           │
│     │   │                                                         │
│     │   ├── before_tool_call (每个工具调用)                      │
│     │   │   ├── 输入: { toolName, params }                       │
│     │   │   ├── 输出: {                                          │
│     │   │   │     allow?,            // 是否允许执行              │
│     │   │   │     modifiedParams?,   // 修改参数                  │
│     │   │   │     substituteResult?  // 替代结果                  │
│     │   │   │   }                                                 │
│     │   │   └── 用途: 权限控制、参数修改                          │
│     │   │                                                         │
│     │   ├── [工具执行]                                           │
│     │   │                                                         │
│     │   ├── after_tool_call                                      │
│     │   │   ├── 输入: { toolName, result }                       │
│     │   │   ├── 输出: { modifiedResult? }                        │
│     │   │   └── 用途: 结果修改、日志记录                          │
│     │   │                                                         │
│     │   └── tool_result_persist                                  │
│     │       ├── 输入: { toolName, result }                       │
│     │       ├── 输出: { persistedContent? }                      │
│     │       └── 用途: 修改持久化内容                              │
│     │                                                             │
│     ├── agent_end                                                │
│     │   ├── 输入: { texts, toolResults }                         │
│     │   ├── 输出: { modifiedTexts? }                             │
│     │   └── 用途: 记忆捕获、结果处理                              │
│     │                                                             │
│     ├── [上下文压缩时]                                           │
│     │   │                                                         │
│     │   ├── before_compaction                                    │
│     │   │   ├── 输入: { messageCount }                           │
│     │   │   └── 用途: 压缩前通知                                  │
│     │   │                                                         │
│     │   └── after_compaction                                     │
│     │       ├── 输入: { compactedCount, tokenCount }             │
│     │       └── 用途: 压缩后处理                                  │
│     │                                                             │
│     └── [Agent 结束]                                             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 Hook 优先级和合并策略

**位置**: `src/plugins/hooks.ts`

```typescript
// Hook 优先级排序
const hooks = getHooksForName(registry, 'before_prompt_build')
  .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

// 合并策略
const mergeBeforePromptBuild = (
  acc: PluginHookBeforePromptBuildResult | undefined,
  next: PluginHookBeforePromptBuildResult,
) => ({
  // 高优先级 hook 优先
  systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
  
  // 内容追加 (按优先级顺序)
  prependContext: concatOptionalTextSegments({
    left: acc?.prependContext,
    right: next.prependContext,
  }),
});
```

**示例**:

```typescript
// 插件 1 (优先级 10): 记忆插件
{
  prependContext: "相关记忆:\n- 用户喜欢使用 TypeScript\n- 项目使用 React"
}

// 插件 2 (优先级 5): 上下文插件
{
  prependContext: "\n当前上下文:\n- 工作目录: /home/user/project"
}

// 合并结果
{
  prependContext: "相关记忆:\n- 用户喜欢使用 TypeScript\n- 项目使用 React\n\n当前上下文:\n- 工作目录: /home/user/project"
}
```

### 4.4 插件注入示例

#### 4.4.1 记忆插件

**位置**: `extensions/memory-lancedb/`

```typescript
// 自动召回 - Agent 启动时注入相关记忆
api.on("before_agent_start", async (event) => {
  // 向量搜索相关记忆
  const results = await db.search(vector, 3, 0.3);
  
  // 格式化为上下文
  const context = formatRelevantMemoriesContext(results);
  
  return {
    prependContext: context
  };
});

// 自动捕获 - Agent 结束后存储重要信息
api.on("agent_end", async (event) => {
  const texts = event.texts;
  
  // 判断哪些内容应该记忆
  const toCapture = texts.filter(text => shouldCapture(text));
  
  // 存储到向量数据库
  for (const text of toCapture) {
    const vector = await embed(text);
    await db.store({ text, vector, category });
  }
});
```

#### 4.4.2 自定义系统提示插件

```typescript
api.on("before_prompt_build", async (event) => {
  // 完全覆盖系统提示
  return {
    systemPrompt: `你是 ${botName}，一个专业的 AI 助手。
    
关键特性:
- 始终使用中文回复
- 代码示例必须包含注释
- 优先推荐最佳实践

当前时间: ${new Date().toISOString()}
    `
  };
});
```

---

## 5. 工具执行流程

### 5.1 工具定义

**位置**: `src/agents/pi-tools.ts`

```typescript
const tools: AnyAgentTool[] = [
  // 文件操作
  createReadTool({ ... }),
  createWriteTool({ ... }),
  createEditTool({ ... }),
  
  // 系统命令
  createExecTool({ ... }),
  
  // 浏览器控制
  createBrowserTool({ ... }),
  
  // 消息发送
  createMessageTool({ ... }),
  
  // 记忆管理
  createMemorySearchTool({ ... }),
  createMemoryGetTool({ ... }),
  
  // ... 更多工具
];
```

### 5.2 工具执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      工具执行流程                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  LLM 决定调用工具                                                 │
│     │                                                             │
│     ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 1. 工具调用解析                                              ││
│  │    - 解析工具名称和参数                                      ││
│  │    - 验证参数 Schema                                         ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 2. before_tool_call hook                                    ││
│  │    - 检查权限                                                ││
│  │    - 修改参数 (可选)                                         ││
│  │    - 阻止执行 (可选)                                         ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│            ┌────────────┴────────────┐                           │
│            │                         │                            │
│            ▼ allow                  ▼ deny                        │
│  ┌──────────────────┐      ┌──────────────────┐                 │
│  │ 3. 沙箱执行       │      │ 返回拒绝消息      │                 │
│  │    - 文件系统隔离 │      └──────────────────┘                 │
│  │    - 命令白名单   │                                           │
│  │    - 网络限制     │                                           │
│  └────────┬─────────┘                                           │
│           │                                                       │
│           ▼                                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 4. after_tool_call hook                                     ││
│  │    - 修改结果 (可选)                                         ││
│  │    - 日志记录                                                ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 5. tool_result_persist hook                                 ││
│  │    - 修改持久化内容                                          ││
│  │    - 敏感信息过滤                                            ││
│  └──────────────────────┬──────────────────────────────────────┘│
│                         │                                         │
│                         ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 6. 结果返回给 LLM                                           ││
│  │    - 格式化为工具结果消息                                    ││
│  │    - 追加到会话历史                                          ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 沙箱执行机制

**位置**: `src/agents/sandbox.ts`

```typescript
// 沙箱策略
type SandboxPolicy = {
  // 文件系统隔离
  fs: {
    allowedPaths: string[];   // 允许访问的路径
    deniedPaths: string[];    // 禁止访问的路径
    readOnlyPaths: string[];  // 只读路径
  };
  
  // 命令执行
  exec: {
    allowedBins: string[];      // 允许的二进制文件
    deniedPatterns: string[];   // 禁止的模式
    requireApproval: string[];  // 需要审批的命令
  };
  
  // 网络访问
  network: {
    allowedHosts: string[];     // 允许的主机
    ssrfProtection: boolean;    // SSRF 防护
  };
};
```

**执行示例**:

```typescript
// 工具调用: read_file
{
  name: "read_file",
  params: {
    filePath: "/home/user/project/src/index.ts"
  }
}

// 沙箱检查
1. 路径检查: /home/user/project 在 allowedPaths 中 ✓
2. 路径检查: 不在 deniedPaths 中 ✓
3. 权限检查: 文件可读 ✓

// 执行
const content = await fs.readFile(filePath, 'utf-8');

// 结果
{
  content: "export function main() { ... }",
  lineCount: 50
}
```

---

## 6. 错误处理与重试机制

### 6.1 重试策略

```
┌─────────────────────────────────────────────────────────────────┐
│                      重试策略                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  错误类型分类                                                     │
│     │                                                             │
│     ├── 1. 上下文溢出 (Context Overflow)                         │
│     │   ├── 检测: isLikelyContextOverflowError                   │
│     │   ├── 处理: 自动压缩 (contextEngine.compact)               │
│     │   ├── 重试: 最多 3 次压缩尝试                              │
│     │   └── 失败: 返回 "Context overflow" 错误                   │
│     │                                                             │
│     ├── 2. 认证失败 (Auth Failure)                               │
│     │   ├── 检测: isAuthAssistantError                           │
│     │   ├── 处理: 切换认证配置 (advanceAuthProfile)              │
│     │   ├── 重试: 遍历所有可用配置                               │
│     │   └── 失败: 返回 "No available auth profile" 错误          │
│     │                                                             │
│     ├── 3. 速率限制 (Rate Limit)                                 │
│     │   ├── 检测: isRateLimitAssistantError                      │
│     │   ├── 处理: 切换配置或模型                                  │
│     │   ├── 冷却: 标记配置冷却状态                                │
│     │   └── 失败: 返回 "Rate limited" 错误                       │
│     │                                                             │
│     ├── 4. 超时 (Timeout)                                        │
│     │   ├── 检测: timedOut 标志                                  │
│     │   ├── 处理: 重试或切换模型                                  │
│     │   └── 失败: 返回 "Request timed out" 错误                  │
│     │                                                             │
│     ├── 5. 计费错误 (Billing Error)                              │
│     │   ├── 检测: isBillingAssistantError                        │
│     │   ├── 处理: 切换配置或模型                                  │
│     │   └── 失败: 返回计费错误信息                                │
│     │                                                             │
│     └── 6. 通用错误 (Generic Error)                              │
│         ├── 重试: 最多 MAX_RUN_LOOP_ITERATIONS 次                │
│         └── 失败: 返回原始错误                                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 上下文溢出处理

```typescript
// 检测上下文溢出
const contextOverflowError = isLikelyContextOverflowError(errorText);

if (contextOverflowError) {
  // 1. 尝试自动压缩
  if (overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    const compactResult = await contextEngine.compact({
      sessionId,
      sessionFile,
      tokenBudget: ctxInfo.tokens,
      force: true,
      compactionTarget: "budget"
    });
    
    if (compactResult.compacted) {
      // 压缩成功，重试
      continue;
    }
  }
  
  // 2. 尝试截断超大工具结果
  if (!toolResultTruncationAttempted) {
    const truncResult = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens
    });
    
    if (truncResult.truncated) {
      // 截断成功，重试
      continue;
    }
  }
  
  // 3. 失败，返回错误
  return {
    payloads: [{
      text: "Context overflow: prompt too large for the model.",
      isError: true
    }]
  };
}
```

### 6.3 认证配置轮换

```typescript
// 认证配置顺序
const profileOrder = resolveAuthProfileOrder({
  cfg: params.config,
  store: authStore,
  provider,
  preferredProfile: preferredProfileId
});

// 遇到错误时切换配置
const advanceAuthProfile = async (): Promise<boolean> => {
  let nextIndex = profileIndex + 1;
  
  while (nextIndex < profileCandidates.length) {
    const candidate = profileCandidates[nextIndex];
    
    // 跳过冷却中的配置
    if (candidate && isProfileInCooldown(authStore, candidate)) {
      nextIndex += 1;
      continue;
    }
    
    try {
      // 尝试使用新配置
      await applyApiKeyInfo(candidate);
      profileIndex = nextIndex;
      return true;
    } catch (err) {
      nextIndex += 1;
    }
  }
  
  return false;
};
```

### 6.4 Failover 机制

```typescript
// Failover 错误类型
type FailoverReason =
  | "rate_limit"      // 速率限制
  | "overloaded"      // 服务过载
  | "auth"            // 认证失败
  | "billing"         // 计费错误
  | "timeout"         // 超时
  | "model_not_found" // 模型未找到
  | "unknown";        // 未知错误

// 抛出 FailoverError 以触发模型切换
if (fallbackConfigured && promptFailoverFailure) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId: lastProfileId,
    status: resolveFailoverStatus(promptFailoverReason)
  });
}
```

---

## 7. 认证与配置管理

### 7.1 认证配置结构

```typescript
// 认证配置文件
type AuthProfile = {
  id: string;              // 配置 ID
  provider: string;        // 提供商
  name: string;            // 显示名称
  apiKey?: string;         // API Key (加密存储)
  baseURL?: string;        // 自定义 API 端点
  headers?: Record<string, string>;  // 自定义请求头
  
  // 状态
  lastUsed?: number;       // 最后使用时间
  lastFailure?: number;    // 最后失败时间
  failureReason?: string;  // 失败原因
  cooldownUntil?: number;  // 冷却截止时间
};

// 配置存储
type AuthProfileStore = {
  profiles: Record<string, AuthProfile>;
  defaultProfile?: string;  // 默认配置 ID
};
```

### 7.2 配置解析流程

```
┌─────────────────────────────────────────────────────────────────┐
│                     配置解析流程                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. 加载配置文件                                                  │
│     ├── ~/.openclaw/config.json (主配置)                         │
│     ├── ~/.openclaw/secrets/*.json (密钥配置)                    │
│     └── Agent 目录下的配置文件                                   │
│                                                                   │
│  2. 解析认证配置                                                  │
│     ├── ensureAuthProfileStore(agentDir)                        │
│     ├── 加载配置文件                                              │
│     └── 解密敏感信息                                              │
│                                                                   │
│  3. 确定配置顺序                                                  │
│     ├── resolveAuthProfileOrder({                               │
│     │     cfg,                                                   │
│     │     store,                                                 │
│     │     provider,                                              │
│     │     preferredProfile                                       │
│     │   })                                                       │
│     ├── 优先级: user > config > default                         │
│     └── 排除冷却中的配置                                          │
│                                                                   │
│  4. 获取 API Key                                                  │
│     ├── getApiKeyForModel({ model, profileId, store })          │
│     ├── 解密 API Key                                             │
│     └── 设置运行时认证                                            │
│                                                                   │
│  5. 特殊处理                                                      │
│     ├── GitHub Copilot: 刷新 Token                               │
│     │   └── resolveCopilotApiToken(githubToken)                 │
│     ├── AWS SDK: 使用 IAM 凭证                                   │
│     └── 自定义 Headers: 应用到请求                                │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 配置优先级

```
优先级 (从高到低):
1. 用户指定 (authProfileIdSource === "user")
   └── CLI 参数 --profile 或配置中的显式指定

2. 配置文件指定 (preferredProfile)
   └── sessionKey 或 agentId 对应的配置

3. 全局默认 (defaultProfile)
   └── auth.profiles 中的默认配置

4. 自动选择
   └── 第一个可用的配置
```

### 7.4 配置示例

```json
// ~/.openclaw/config.json
{
  "auth": {
    "profiles": {
      "openai-main": {
        "id": "openai-main",
        "provider": "openai",
        "name": "OpenAI Main",
        "apiKey": "encrypted:..."
      },
      "openai-backup": {
        "id": "openai-backup",
        "provider": "openai",
        "name": "OpenAI Backup",
        "apiKey": "encrypted:..."
      },
      "anthropic-main": {
        "id": "anthropic-main",
        "provider": "anthropic",
        "name": "Anthropic Main",
        "apiKey": "encrypted:..."
      }
    },
    "defaultProfile": "openai-main"
  },
  
  "agents": {
    "defaults": {
      "provider": "openai",
      "model": "gpt-4-turbo",
      "authProfileId": "openai-main"
    },
    
    "models": [
      {
        "id": "gpt-4-turbo",
        "provider": "openai",
        "fallback": "gpt-3.5-turbo"
      }
    ]
  }
}
```

---

## 8. 核心文件索引

### 8.1 主要文件

| 文件路径 | 功能描述 |
|---------|---------|
| `src/agents/pi-embedded-runner/run.ts` | Agent 运行主入口 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 单次执行尝试 |
| `src/agents/system-prompt.ts` | 系统提示构建 |
| `src/agents/bootstrap-files.ts` | Bootstrap 文件注入 |
| `src/agents/pi-tools.ts` | 工具定义 |
| `src/agents/sandbox.ts` | 沙箱执行环境 |
| `src/plugins/hooks.ts` | Hook 执行器 |
| `src/plugins/types.ts` | Hook 类型定义 |
| `src/agents/model-auth.ts` | 模型认证管理 |
| `src/agents/model-selection.ts` | 模型选择逻辑 |
| `src/context-engine/index.ts` | 上下文引擎入口 |
| `src/auto-reply/reply/agent-runner.ts` | Reply Agent 运行器 |

### 8.2 辅助文件

| 文件路径 | 功能描述 |
|---------|---------|
| `src/agents/pi-embedded-runner/run/params.ts` | 参数类型定义 |
| `src/agents/pi-embedded-runner/run/payloads.ts` | 结果载荷构建 |
| `src/agents/pi-embedded-runner/run/failover-observation.ts` | Failover 日志 |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | 工具结果截断 |
| `src/agents/context-window-guard.ts` | 上下文窗口检查 |
| `src/agents/usage.ts` | 使用量统计 |
| `src/agents/auth-profiles.ts` | 认证配置管理 |
| `src/agents/runtime-plugins.ts` | 运行时插件加载 |

### 8.3 Hook 相关文件

| 文件路径 | 功能描述 |
|---------|---------|
| `src/plugins/hook-runner-global.ts` | 全局 Hook 运行器 |
| `src/plugins/registry.ts` | 插件注册表 |
| `src/plugins/loader.ts` | 插件加载器 |
| `extensions/memory-lancedb/` | 记忆插件实现 |
| `extensions/diagnostics-otel/` | 诊断插件实现 |

---

## 总结

OpenClaw 的 Agent 模式通过以下核心机制实现灵活、可靠的 AI Agent 执行:

### 核心机制

1. **分层架构**
   - Gateway 控制平面: 统一的请求路由和会话管理
   - Agent 运行时: 基于 `@mariozechner/pi-coding-agent` 的执行环境
   - LLM Provider: 多模型支持与抽象

2. **模块化上下文构建**
   - 系统提示: 由多个 section 模块化构建
   - Bootstrap 注入: 启动时自动注入记忆和自定义文件
   - 动态加载: 通过工具系统按需获取上下文

3. **Hook 注入系统**
   - 生命周期钩子: 覆盖 Agent 执行的各个阶段
   - 优先级控制: 高优先级 Hook 优先执行
   - 灵活修改: 可修改系统提示、工具调用、结果等

4. **错误处理与重试**
   - 分类处理: 针对不同错误类型的专门处理
   - 自动重试: 上下文压缩、配置切换等自动恢复机制
   - Failover 机制: 模型级别的故障转移

5. **认证与配置管理**
   - 多配置支持: 支持多个 API Key 和配置文件
   - 自动轮换: 遇到错误时自动切换配置
   - 冷却机制: 避免频繁使用失败的配置

这种设计实现了高度可定制、可扩展和可靠的 Agent 执行环境，能够适应各种复杂的使用场景。

---

*文档版本: 2026.3.25*
*基于 OpenClaw v2026.3.13*
