# OpenClaw 记忆功能架构文档

## 概述

OpenClaw 的记忆系统是一个**文件优先、向量增强**的架构，允许 AI Agent 在跨会话中保持上下文记忆。

## 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Memory Architecture                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  Memory Files (Markdown)                     │   │
│  │  ~/.openclaw/workspace/                                      │   │
│  │  ├── MEMORY.md          # 长期记忆                           │   │
│  │  └── memory/            # 每日日志                           │   │
│  │      └── YYYY-MM-DD.md  # 按日期的记忆文件                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                Memory Index Manager                          │   │
│  │              src/memory/manager.ts                           │   │
│  │  - 文件监控 (chokidar)                                       │   │
│  │  - 自动索引同步 (debounce)                                   │   │
│  │  - 向量化嵌入 (embedding)                                    │   │
│  │  - 混合检索 (Vector + BM25)                                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Storage Layer                             │   │
│  │  SQLite (~/.openclaw/memory/<agentId>.sqlite)               │   │
│  │  ├── files      # 文件元数据                                 │   │
│  │  ├── chunks     # 文本块 + 嵌入向量                          │   │
│  │  ├── embedding_cache  # 嵌入缓存                             │   │
│  │  └── chunks_fts # 全文搜索虚拟表 (FTS5)                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Agent Tools                                │   │
│  │           src/agents/tools/memory-tool.ts                   │   │
│  │  - memory_search  # 语义搜索                                 │   │
│  │  - memory_get     # 读取特定文件                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 记忆文件层

| 文件 | 用途 | 特点 |
|------|------|------|
| `MEMORY.md` | 长期记忆 | 持久化的决策、偏好、重要事实 |
| `memory/YYYY-MM-DD.md` | 每日日志 | 按日期自动创建，追加式记录 |

**示例格式：**

```markdown
# memory/2026-03-16.md
- Session: 2026-03-16 14:30:00 UTC
- Session Key: agent:main:main
- 决定使用 OpenAI 作为主要嵌入提供者
- 用户偏好：简洁的回复风格
```

### 2. 索引管理器 (MemoryIndexManager)

**位置：** `src/memory/manager.ts`

**核心职责：**

```typescript
class MemoryIndexManager {
  // 1. 文件监控 - 自动检测 memory 文件变化
  watcher: FSWatcher;
  
  // 2. 嵌入提供者支持
  provider: EmbeddingProvider | null;
  // 支持: OpenAI, Gemini, Voyage, Mistral, Ollama, 本地模型
  
  // 3. 混合搜索
  async search(query: string, opts?: {...}): Promise<MemorySearchResult[]> {
    // 向量搜索 (语义匹配)
    const vectorResults = await this.searchVector(queryVec, candidates);
    // 关键词搜索 (精确匹配 BM25)
    const keywordResults = await this.searchKeyword(query, candidates);
    // 合并结果
    return this.mergeHybridResults({...});
  }
}
```

### 3. 数据库 Schema

**位置：** `src/memory/memory-schema.ts`

```sql
-- 文件元数据
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT,        -- 'memory' | 'sessions'
  hash TEXT,          -- 内容哈希
  mtime INTEGER,      -- 修改时间
  size INTEGER
);

-- 文本块 + 向量
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  text TEXT,
  embedding TEXT,     -- JSON 编码的向量
  model TEXT          -- 嵌入模型
);

-- 全文搜索 (FTS5)
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, id, path, ...);
```

### 4. Agent 工具

**位置：** `src/agents/tools/memory-tool.ts`

| 工具 | 功能 | 返回值 |
|------|------|--------|
| `memory_search` | 语义搜索记忆文件 | 匹配的文本片段 + 文件路径 + 行号 |
| `memory_get` | 读取特定记忆文件 | 文件内容 (可选行范围) |

**调用示例：**

```typescript
// memory_search 调用
{
  query: "用户对 API 设计的偏好",
  maxResults: 5,
  minScore: 0.3
}

// 返回结果
{
  results: [{
    snippet: "用户偏好 RESTful API 风格...",
    path: "MEMORY.md",
    startLine: 45,
    endLine: 50,
    score: 0.89,
    citation: "MEMORY.md#L45-L50"
  }]
}
```

## 自动记忆流程

### Session Memory Hook

当用户执行 `/new` 或 `/reset` 时自动保存会话记忆：

**位置：** `src/hooks/bundled/session-memory/handler.ts`

```typescript
const saveSessionToMemory: HookHandler = async (event) => {
  // 1. 读取最近 N 条消息 (默认 15 条)
  const sessionContent = await getRecentSessionContent(sessionFile, messageCount);
  
  // 2. 使用 LLM 生成描述性文件名 slug
  const slug = await generateSlugViaLLM({ sessionContent, cfg });
  
  // 3. 写入记忆文件
  // memory/YYYY-MM-DD-{slug}.md
  await writeFileWithinRoot({
    rootDir: memoryDir,
    relativePath: `${dateStr}-${slug}.md`,
    data: entry
  });
};
```

### 预压缩记忆刷新

当会话接近上下文限制时，自动触发静默刷新：

```typescript
// 配置项
memoryFlush: {
  enabled: true,
  softThresholdTokens: 4000,
  prompt: "Write lasting notes to memory/YYYY-MM-DD.md; reply NO_REPLY if nothing."
}
```

## 搜索模式

### 混合搜索 (Hybrid Search)

```typescript
// 向量权重 + 文本权重 = 最终分数
finalScore = vectorWeight * vectorScore + textWeight * textScore;

// 配置
hybrid: {
  enabled: true,
  vectorWeight: 0.7,
  textWeight: 0.3,
  candidateMultiplier: 4
}
```

### 后处理增强

| 特性 | 作用 | 配置 |
|------|------|------|
| **MMR 重排序** | 减少重复结果，增加多样性 | `mmr: { enabled: true, lambda: 0.7 }` |
| **时间衰减** | 新记忆优先，旧记忆降权 | `temporalDecay: { enabled: true, halfLifeDays: 30 }` |

## 嵌入提供者选择

```
自动选择优先级:
1. local (如果有本地模型配置)
2. openai (如果有 OpenAI key)
3. gemini (如果有 Gemini key)
4. voyage (如果有 Voyage key)
5. mistral (如果有 Mistral key)
6. 否则禁用记忆搜索
```

## 扩展插件

| 插件 | 存储后端 | 特点 |
|------|----------|------|
| `memory-core` | SQLite + 本地向量 | 内置，轻量级 |
| `memory-lancedb` | LanceDB + OpenAI | 向量数据库，支持自动捕获/召回 |

### memory-lancedb 扩展功能

```typescript
// 自动召回 - Agent 启动时注入相关记忆
api.on("before_agent_start", async (event) => {
  const results = await db.search(vector, 3, 0.3);
  return { prependContext: formatRelevantMemoriesContext(results) };
});

// 自动捕获 - Agent 结束后存储重要信息
api.on("agent_end", async (event) => {
  const toCapture = texts.filter(text => shouldCapture(text));
  await db.store({ text, vector, category });
});
```

## 数据流

```
用户消息 → Agent 处理
              │
              ├─→ memory_search (查询相关记忆)
              │       │
              │       ├─→ 向量搜索
              │       ├─→ BM25 搜索
              │       └─→ 合并 + 排序
              │
              ├─→ Agent 生成回复
              │
              └─→ /new 或 /reset
                      │
                      └─→ Session Memory Hook
                              │
                              └─→ 写入 memory/YYYY-MM-DD-{slug}.md
                                      │
                                      └─→ 文件监控触发重新索引
```

## 关键文件索引

| 文件路径 | 功能 |
|----------|------|
| `src/memory/manager.ts` | 记忆索引管理器 |
| `src/memory/search-manager.ts` | 搜索逻辑封装 |
| `src/memory/memory-schema.ts` | SQLite Schema 定义 |
| `src/memory/index.ts` | 模块导出 |
| `src/agents/tools/memory-tool.ts` | Agent 工具定义 |
| `src/hooks/bundled/session-memory/` | 会话记忆 Hook |
| `src/config/types.memory.ts` | 配置类型定义 |
| `extensions/memory-core/` | 核心记忆插件 |
| `extensions/memory-lancedb/` | LanceDB 记忆插件 |

## 配置参考

```typescript
// ~/.openclaw/config.json
{
  "memory": {
    "enabled": true,
    "embedding": {
      "provider": "openai",  // openai | gemini | voyage | mistral | ollama | local
      "model": "text-embedding-3-small"
    },
    "search": {
      "hybrid": {
        "enabled": true,
        "vectorWeight": 0.7,
        "textWeight": 0.3
      },
      "mmr": {
        "enabled": true,
        "lambda": 0.7
      },
      "temporalDecay": {
        "enabled": true,
        "halfLifeDays": 30
      }
    },
    "flush": {
      "enabled": true,
      "softThresholdTokens": 4000
    }
  }
}
```

## 总结

OpenClaw 记忆系统的设计原则：

1. **Markdown 作为真实来源** - 记忆存储在纯文本文件中，人类可读可编辑
2. **SQLite 索引** - 快速本地搜索，支持向量和全文
3. **混合检索** - 语义搜索 + 关键词搜索结合
4. **自动流程** - 会话结束自动保存，接近压缩自动刷新
5. **插件化** - 可切换不同存储后端 (SQLite / LanceDB)
