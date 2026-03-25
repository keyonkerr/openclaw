/**
 * OpenClaw Agent 嵌入式运行器主入口
 * 
 * 这个文件是 OpenClaw Agent 模式的核心执行引擎，负责：
 * 1. Agent 会话的完整生命周期管理
 * 2. 多模型、多认证配置的故障转移和重试机制
 * 3. 上下文溢出的自动压缩和恢复
 * 4. Hook 系统的执行和协调
 * 5. 工具调用的沙箱执行和结果处理
 * 
 * 主要函数：
 * - runEmbeddedPiAgent: 主入口函数，执行完整的 Agent 运行流程
 * 
 * 核心机制：
 * - 分层重试：认证配置轮换 → 模型切换 → 上下文压缩
 * - 错误分类：上下文溢出、认证失败、速率限制、超时、计费错误等
 * - 自动恢复：上下文压缩、工具结果截断、配置冷却管理
 * 
 * @module agents/pi-embedded-runner/run
 */

// ============================================================================
// Node.js 核心模块导入
// ============================================================================
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";

// ============================================================================
// OpenClaw 内部模块导入
// ============================================================================

// 自动回复相关
import type { ThinkLevel } from "../../auto-reply/thinking.js";

// 上下文引擎（会话压缩、上下文管理）
import {
  ensureContextEnginesInitialized,
  resolveContextEngine,
} from "../../context-engine/index.js";

// 基础设施：退避策略、安全随机数
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { generateSecureToken } from "../../infra/secure-random.js";

// 插件系统：Hook 运行器和类型定义
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentStartResult } from "../../plugins/types.js";

// 进程管理：命令队列
import { enqueueCommandInLane } from "../../process/command-queue.js";

// 消息渠道工具
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";

// Agent 路径和配置
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { hasConfiguredModelFallbacks } from "../agent-scope.js";

// 认证配置管理
import {
  isProfileInCooldown,
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
} from "../auth-profiles.js";

// 上下文窗口管理
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";

// 默认配置
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";

// Failover 错误处理
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";

// 模型认证和选择
import {
  applyLocalNoAuthHeaderOverride,
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";

// 辅助函数：错误分类、消息格式化
import {
  formatBillingErrorMessage,
  classifyFailoverReason,
  extractObservedOverflowTokenCount,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  parseImageSizeError,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
  type FailoverReason,
} from "../pi-embedded-helpers.js";

// 运行时插件加载
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";

// 使用量统计
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";

// 工作目录和会话标识
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";

// 内部模块导入
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import {
  truncateOversizedToolResultsInSession,
  sessionLikelyHasOversizedToolResults,
} from "./tool-result-truncation.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { describeUnknownError } from "./utils.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * API Key 信息类型
 * 包含解析后的认证信息：API Key、配置 ID、认证模式等
 */
type ApiKeyInfo = ResolvedProviderAuth;

/**
 * GitHub Copilot Token 状态
 * 用于管理 Copilot 的短期访问令牌及其自动刷新
 */
type CopilotTokenState = {
  githubToken: string;                                    // GitHub 访问令牌
  expiresAt: number;                                      // 令牌过期时间（Unix 时间戳）
  refreshTimer?: ReturnType<typeof setTimeout>;          // 自动刷新定时器
  refreshInFlight?: Promise<void>;                       // 正在进行的刷新操作
};

// ============================================================================
// 常量定义
// ============================================================================

// Copilot Token 刷新相关常量
const COPILOT_REFRESH_MARGIN_MS = 5 * 60 * 1000;     // 提前 5 分钟刷新
const COPILOT_REFRESH_RETRY_MS = 60 * 1000;          // 刷新失败后重试间隔
const COPILOT_REFRESH_MIN_DELAY_MS = 5 * 1000;       // 最小刷新延迟

/**
 * 过载故障转移退避策略
 * 
 * 当服务过载时，使用指数退避算法避免重试风暴：
 * - 初始延迟：250ms
 * - 最大延迟：1500ms
 * - 退避因子：2x
 * - 抖动系数：0.2
 * 
 * 这样设计既避免了紧密重试造成的额外负载，
 * 又保证了故障转移在单次对话内仍然响应迅速
 */
const OVERLOAD_FAILOVER_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 1_500,
  factor: 2,
  jitter: 0.2,
};

/**
 * Anthropic 魔法字符串常量
 * 
 * 用于防止 Anthropic 的拒绝测试（refusal test）污染会话记录。
 * 某些特殊字符串可能触发 Anthropic 模型的拒绝响应，
 * 我们将其替换为安全的占位符
 */
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Cache fields from the most recent API call (not accumulated). */
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};

const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});

function createCompactionDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

// Defensive guard for the outer run loop across all retry branches.
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

const hasUsageValues = (
  usage: ReturnType<typeof normalizeUsage>,
): usage is NonNullable<ReturnType<typeof normalizeUsage>> =>
  !!usage &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: ReturnType<typeof normalizeUsage>,
) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total +=
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  // Track the most recent API call's cache fields for accurate context-size reporting.
  // Accumulated cache totals inflate context size when there are multiple tool-call round-trips,
  // since each call reports cacheRead ≈ current_context_size.
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastInput = usage.input ?? 0;
};

const toNormalizedUsage = (usage: UsageAccumulator) => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  // Use the LAST API call's cache fields for context-size calculation.
  // The accumulated cacheRead/cacheWrite inflate context size because each tool-call
  // round-trip reports cacheRead ≈ current_context_size, and summing N calls gives
  // N × context_size which gets clamped to contextWindow (e.g. 200k).
  // See: https://github.com/openclaw/openclaw/issues/13698
  //
  // We use lastInput/lastCacheRead/lastCacheWrite (from the most recent API call) for
  // cache-related fields, but keep accumulated output (total generated text this turn).
  const lastPromptTokens = usage.lastInput + usage.lastCacheRead + usage.lastCacheWrite;
  return {
    input: usage.lastInput || undefined,
    output: usage.output || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    total: lastPromptTokens + usage.output || undefined,
  };
};

function resolveActiveErrorContext(params: {
  lastAssistant: { provider?: string; model?: string } | undefined;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.lastAssistant?.provider ?? params.provider,
    model: params.lastAssistant?.model ?? params.model,
  };
}

/**
 * Build agentMeta for error return paths, preserving accumulated usage so that
 * session totalTokens reflects the actual context size rather than going stale.
 * Without this, error returns omit usage and the session keeps whatever
 * totalTokens was set by the previous successful run.
 */
function buildErrorAgentMeta(params: {
  sessionId: string;
  provider: string;
  model: string;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  lastAssistant?: { usage?: unknown } | null;
  /** API-reported total from the most recent call, mirroring the success path correction. */
  lastTurnTotal?: number;
}): EmbeddedPiAgentMeta {
  const usage = toNormalizedUsage(params.usageAccumulator);
  // Apply the same lastTurnTotal correction the success path uses so
  // usage.total reflects the API-reported context size, not accumulated totals.
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const lastCallUsage = params.lastAssistant
    ? normalizeUsage(params.lastAssistant.usage as UsageLike)
    : undefined;
  const promptTokens = derivePromptTokens(params.lastRunPromptUsage);
  return {
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    // Only include usage fields when we have actual data from prior API calls.
    ...(usage ? { usage } : {}),
    ...(lastCallUsage ? { lastCallUsage } : {}),
    ...(promptTokens ? { promptTokens } : {}),
  };
}

/**
 * 运行嵌入式 Pi Agent 的主入口函数
 * 
 * 这是 OpenClaw Agent 模式的核心执行引擎,负责管理一个完整的 Agent 会话生命周期。
 * 该函数实现了以下核心功能:
 * 
 * ## 1. 会话管理
 * - 解析会话标识(sessionKey/sessionId)
 * - 确定工作目录(workspace directory)
 * - 加载运行时插件
 * 
 * ## 2. 模型选择与配置
 * - 通过 Hook 系统允许插件覆盖模型选择
 * - 解析模型配置和上下文窗口限制
 * - 检查模型可用性
 * 
 * ## 3. 认证配置管理
 * - 加载认证配置文件
 * - 支持多个认证配置的轮换
 * - 自动处理 GitHub Copilot token 刷新
 * - 配置冷却机制(避免频繁使用失败的配置)
 * 
 * ## 4. 错误处理与重试机制
 * - **上下文溢出**: 自动压缩会话历史或截断超大工具结果
 * - **认证失败**: 自动切换到下一个可用的认证配置
 * - **速率限制**: 标记配置冷却状态并切换
 * - **超时**: 尝试切换配置或模型
 * - **计费错误**: 切换配置或触发模型 fallback
 * 
 * ## 5. Hook 系统集成
 * - before_model_resolve: 允许插件覆盖模型选择
 * - before_agent_start: 兼容性 Hook,支持旧版插件
 * - before_compaction/after_compaction: 上下文压缩通知
 * 
 * ## 6. 工具执行循环
 * - 调用 runEmbeddedAttempt 执行单次 Agent 推理
 * - 处理工具调用和沙箱执行
 * - 收集使用量统计(usage)
 * 
 * ## 7. 结果构建
 * - 构建包含文本、工具结果的 payload
 * - 生成 agentMeta(会话元数据)
 * - 返回最终的 EmbeddedPiRunResult
 * 
 * ## 执行流程
 * ```
 * 初始化 → 加载配置 → 选择模型 → 选择认证 → 主循环 {
 *   检查重试限制
 *   执行 attempt
 *   处理错误 → 重试/压缩/切换配置
 *   成功 → 返回结果
 * }
 * ```
 * 
 * ## 关键特性
 * - **多层 Failover**: 认证配置 → 模型切换 → 上下文压缩
 * - **自动恢复**: 上下文溢出时自动压缩会话
 * - **安全隔离**: 工具调用在沙箱环境中执行
 * - **使用量追踪**: 精确统计 token 使用情况
 * 
 * @param params - 运行参数,包括会话标识、模型配置、认证信息等
 * @returns EmbeddedPiRunResult - 包含响应文本、工具结果、元数据等
 * @throws FailoverError - 当需要模型级 fallback 时抛出
 * @throws Error - 其他不可恢复的错误
 * 
 * @example
 * ```typescript
 * const result = await runEmbeddedPiAgent({
 *   sessionId: "session-123",
 *   sessionKey: "user-456",
 *   prompt: "帮我分析这段代码",
 *   provider: "openai",
 *   model: "gpt-4-turbo",
 *   workspaceDir: "/home/user/project",
 *   config: appConfig,
 * });
 * 
 * console.log(result.payloads); // 文本和工具结果
 * console.log(result.meta.agentMeta.usage); // token 使用量
 * ```
 */
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // ============================================================================
  // 阶段 1: 会话队列和格式解析
  // ============================================================================
  
  // 解析会话级命令队列 - 用于串行化同一会话的请求
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  
  // 解析全局命令队列 - 用于全局并发控制
  const globalLane = resolveGlobalLane(params.lane);
  
  // 设置任务入队函数(使用参数提供的或默认实现)
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  
  // 确定工具结果的输出格式
  // 如果指定了消息渠道,根据渠道能力选择 markdown 或 plain
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown"); // 默认使用 markdown
  
  // 检测是否为探测会话(probe session)
  // 探测会话用于健康检查或能力探测,可能有不同的错误处理策略
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  // 使用双层队列包装执行:
  // 1. sessionLane: 保证同一会话的请求串行执行
  // 2. globalLane: 控制全局并发度
  return enqueueSession(() =>
    enqueueGlobal(async () => {
      // ============================================================================
      // 阶段 2: 工作目录解析和运行时初始化
      // ============================================================================
      
      const started = Date.now(); // 记录开始时间,用于计算总耗时
      
      // 解析工作目录 - 确定会话的工作空间位置
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      
      // 对敏感标识进行脱敏,用于日志输出
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      
      // 如果使用了 fallback 工作目录,记录警告
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      
      // 加载运行时插件 - 确保工作目录相关的插件已加载
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
      });
      
      // 保存当前工作目录,在 finally 中恢复
      const prevCwd = process.cwd();

      // ============================================================================
      // 阶段 3: 模型配置初始化
      // ============================================================================
      
      // 解析 provider 和 model ID
      // 如果参数未指定,使用默认值
      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      
      // 确定 Agent 目录位置
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      
      // 检查是否配置了模型 fallback 机制
      // 如果配置了 fallback,在遇到错误时可以自动切换到备用模型
      const fallbackConfigured = hasConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      
      // 确保 OpenClaw 模型配置文件已加载
      // 这个配置文件定义了可用模型、上下文窗口等信息
      await ensureOpenClawModelsJson(params.config, agentDir);

      // ============================================================================
      // 阶段 4: Hook 系统 - 模型选择覆盖
      // ============================================================================
      
      // 运行 before_model_resolve hooks,允许插件覆盖模型选择
      // 这是插件系统的关键入口点,可以实现:
      // - 基于提示内容的动态模型选择
      // - 负载均衡(将请求分散到不同模型)
      // - 成本优化(选择更便宜的模型)
      //
      // 兼容性: 同时检查 before_agent_start hook (旧版)
      // 新版 hook (before_model_resolve) 优先级更高
      let modelResolveOverride: { providerOverride?: string; modelOverride?: string } | undefined;
      let legacyBeforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;
      
      const hookRunner = getGlobalHookRunner();
      
      // 构建 Hook 上下文 - 包含所有相关运行时信息
      const hookCtx = {
        agentId: workspaceResolution.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        messageProvider: params.messageProvider ?? undefined,
        trigger: params.trigger,
        channelId: params.messageChannel ?? params.messageProvider ?? undefined,
      };
      
      // 执行 before_model_resolve hook (推荐使用)
      if (hookRunner?.hasHooks("before_model_resolve")) {
        try {
          modelResolveOverride = await hookRunner.runBeforeModelResolve(
            { prompt: params.prompt },
            hookCtx,
          );
        } catch (hookErr) {
          log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
        }
      }
      
      // 执行 before_agent_start hook (兼容旧版插件)
      if (hookRunner?.hasHooks("before_agent_start")) {
        try {
          legacyBeforeAgentStartResult = await hookRunner.runBeforeAgentStart(
            { prompt: params.prompt },
            hookCtx,
          );
          // 合并覆盖设置,新版 hook 优先
          modelResolveOverride = {
            providerOverride:
              modelResolveOverride?.providerOverride ??
              legacyBeforeAgentStartResult?.providerOverride,
            modelOverride:
              modelResolveOverride?.modelOverride ?? legacyBeforeAgentStartResult?.modelOverride,
          };
        } catch (hookErr) {
          log.warn(
            `before_agent_start hook (legacy model resolve path) failed: ${String(hookErr)}`,
          );
        }
      }
      
      // 应用模型覆盖设置
      if (modelResolveOverride?.providerOverride) {
        provider = modelResolveOverride.providerOverride;
        log.info(`[hooks] provider overridden to ${provider}`);
      }
      if (modelResolveOverride?.modelOverride) {
        modelId = modelResolveOverride.modelOverride;
        log.info(`[hooks] model overridden to ${modelId}`);
      }

      // ============================================================================
      // 阶段 5: 模型解析和上下文窗口检查
      // ============================================================================
      
      // 解析模型配置
      // 返回: model(模型配置), error(错误信息), authStorage(认证存储), modelRegistry(模型注册表)
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      
      // 如果模型未找到,抛出 FailoverError 触发模型级 fallback
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
        });
      }

      // 解析上下文窗口信息
      // 确定模型实际可用的 token 数量
      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      
      // 应用上下文 token 限制
      // 如果配置的 contextTokens 小于模型的原始上下文窗口,
      // 使用限制值作为有效上下文窗口
      // 这样 pi-coding-agent 的自动压缩阈值会使用有效限制
      const effectiveModel =
        ctxInfo.tokens < (model.contextWindow ?? Infinity)
          ? { ...model, contextWindow: ctxInfo.tokens }
          : model;
      
      // 评估上下文窗口是否足够
      // 检查是否低于警告阈值或硬性最小值
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      
      // 如果上下文窗口过小,记录警告
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      
      // 如果上下文窗口低于硬性最小值,阻止执行
      // 这可以防止使用无法正常工作的模型(如非常小的模型)
      if (ctxGuard.shouldBlock) {
        log.error(
          `blocked model (context window too small): ${provider}/${modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
        );
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      // ============================================================================
      // 阶段 6: 认证配置管理
      // ============================================================================
      
      // 加载认证配置存储
      // authStore 包含所有可用的 API Key 和认证配置
      // allowKeychainPrompt: false 表示不提示用户输入密钥
      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      
      // 解析首选认证配置 ID
      const preferredProfileId = params.authProfileId?.trim();
      
      // 确定是否锁定到特定配置
      // 如果 authProfileIdSource === "user",表示用户显式指定,不能切换
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      
      // 验证锁定的配置是否有效
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      
      // 解析认证配置的优先级顺序
      // 优先级: user > config > default
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });
      
      // 验证锁定配置是否在优先级列表中
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }
      
      // 构建候选配置列表
      // 如果锁定到特定配置,只使用该配置
      // 否则使用完整的优先级列表
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined]; // 如果没有配置,使用 undefined 表示使用默认认证
      
      // 当前使用的配置索引
      let profileIndex = 0;

      // ============================================================================
      // 阶段 7: 思考级别和 GitHub Copilot Token 管理
      // ============================================================================
      
      // 思考级别(think level)控制模型的推理深度
      // 某些模型(如 Claude)支持扩展思考功能
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>(); // 记录已尝试的思考级别
      
      // API Key 信息
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;
      
      // GitHub Copilot 特殊处理
      // Copilot 使用短期访问令牌,需要定期刷新
      const copilotTokenState: CopilotTokenState | null =
        model.provider === "github-copilot" ? { githubToken: "", expiresAt: 0 } : null;
      let copilotRefreshCancelled = false;
      
      // 检查是否有可用的 GitHub token
      const hasCopilotGithubToken = () => Boolean(copilotTokenState?.githubToken.trim());

      // 清除 Copilot token 刷新定时器
      const clearCopilotRefreshTimer = () => {
        if (!copilotTokenState?.refreshTimer) {
          return;
        }
        clearTimeout(copilotTokenState.refreshTimer);
        copilotTokenState.refreshTimer = undefined;
      };

      // 停止 Copilot token 刷新
      const stopCopilotRefreshTimer = () => {
        if (!copilotTokenState) {
          return;
        }
        copilotRefreshCancelled = true;
        clearCopilotRefreshTimer();
      };

      // 刷新 GitHub Copilot 访问令牌
      // Copilot token 有效期约 1 小时,需要提前刷新以避免中断
      const refreshCopilotToken = async (reason: string): Promise<void> => {
        if (!copilotTokenState) {
          return;
        }
        // 防止并发刷新
        if (copilotTokenState.refreshInFlight) {
          await copilotTokenState.refreshInFlight;
          return;
        }
        
        // 动态导入 Copilot token 解析模块
        const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
        
        copilotTokenState.refreshInFlight = (async () => {
          const githubToken = copilotTokenState.githubToken.trim();
          if (!githubToken) {
            throw new Error("Copilot refresh requires a GitHub token.");
          }
          
          log.debug(`Refreshing GitHub Copilot token (${reason})...`);
          
          // 使用 GitHub token 交换 Copilot API token
          const copilotToken = await resolveCopilotApiToken({
            githubToken,
          });
          
          // 更新运行时认证配置
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
          copilotTokenState.expiresAt = copilotToken.expiresAt;
          
          const remaining = copilotToken.expiresAt - Date.now();
          log.debug(
            `Copilot token refreshed; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
          );
        })()
          .catch((err) => {
            log.warn(`Copilot token refresh failed: ${describeUnknownError(err)}`);
            throw err;
          })
          .finally(() => {
            copilotTokenState.refreshInFlight = undefined;
          });
        await copilotTokenState.refreshInFlight;
      };

      // 调度下一次 Copilot token 刷新
      // 提前 COPILOT_REFRESH_MARGIN_MS 毫秒刷新,避免过期
      const scheduleCopilotRefresh = (): void => {
        if (!copilotTokenState || copilotRefreshCancelled) {
          return;
        }
        if (!hasCopilotGithubToken()) {
          log.warn("Skipping Copilot refresh scheduling; GitHub token missing.");
          return;
        }
        
        clearCopilotRefreshTimer();
        const now = Date.now();
        const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS;
        const delayMs = Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - now);
        
        const timer = setTimeout(() => {
          if (copilotRefreshCancelled) {
            return;
          }
          
          // 执行刷新并重新调度
          refreshCopilotToken("scheduled")
            .then(() => scheduleCopilotRefresh())
            .catch(() => {
              if (copilotRefreshCancelled) {
                return;
              }
              
              // 刷新失败,设置重试定时器
              const retryTimer = setTimeout(() => {
                if (copilotRefreshCancelled) {
                  return;
                }
                refreshCopilotToken("scheduled-retry")
                  .then(() => scheduleCopilotRefresh())
                  .catch(() => undefined);
              }, COPILOT_REFRESH_RETRY_MS);
              
              copilotTokenState.refreshTimer = retryTimer;
              if (copilotRefreshCancelled) {
                clearTimeout(retryTimer);
                copilotTokenState.refreshTimer = undefined;
              }
            });
        }, delayMs);
        
        copilotTokenState.refreshTimer = timer;
        if (copilotRefreshCancelled) {
          clearTimeout(timer);
          copilotTokenState.refreshTimer = undefined;
        }
      };

      // ============================================================================
      // 阶段 8: 认证配置 Failover 辅助函数
      // ============================================================================
      
      // 解析认证配置失败的原因
      // 用于确定应该触发哪种类型的 failover
      const resolveAuthProfileFailoverReason = (params: {
        allInCooldown: boolean;
        message: string;
        profileIds?: Array<string | undefined>;
      }): FailoverReason => {
        // 如果所有配置都在冷却中,检查具体原因
        if (params.allInCooldown) {
          const profileIds = (params.profileIds ?? profileCandidates).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          return (
            resolveProfilesUnavailableReason({
              store: authStore,
              profileIds,
            }) ?? "unknown"
          );
        }
        // 根据错误消息分类 failover 原因
        const classified = classifyFailoverReason(params.message);
        return classified ?? "auth";
      };

      // 抛出认证配置 failover 错误
      // 如果配置了模型 fallback,抛出 FailoverError 触发模型切换
      // 否则抛出普通错误
      const throwAuthProfileFailover = (params: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          params.message?.trim() ||
          (params.error ? describeUnknownError(params.error).trim() : "") ||
          fallbackMessage;
        
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: params.allInCooldown,
          message,
          profileIds: profileCandidates,
        });
        
        // 如果配置了 fallback,触发模型级 failover
        if (fallbackConfigured) {
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: params.error,
          });
        }
        
        // 否则抛出原始错误或新错误
        if (params.error instanceof Error) {
          throw params.error;
        }
        throw new Error(message);
      };

      // 为指定候选配置解析 API Key
      const resolveApiKeyForCandidate = async (candidate?: string) => {
        return getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
          agentDir,
        });
      };

      // 应用认证配置信息
      // 设置运行时 API Key 并处理特殊提供商(如 GitHub Copilot)
      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
        
        // 如果没有 API Key,检查认证模式
        if (!apiKeyInfo.apiKey) {
          // AWS SDK 模式不需要显式 API Key(使用 IAM 角色)
          if (apiKeyInfo.mode !== "aws-sdk") {
            throw new Error(
              `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
            );
          }
          lastProfileId = resolvedProfileId;
          return;
        }
        
        // GitHub Copilot 特殊处理:交换短期访问令牌
        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
          
          // 启动自动刷新机制
          if (copilotTokenState) {
            copilotTokenState.githubToken = apiKeyInfo.apiKey;
            copilotTokenState.expiresAt = copilotToken.expiresAt;
            scheduleCopilotRefresh();
          }
        } else {
          // 普通提供商:直接设置 API Key
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
        
        lastProfileId = apiKeyInfo.profileId;
      };

      // 推进到下一个认证配置
      // 用于处理认证失败、速率限制等错误
      const advanceAuthProfile = async (): Promise<boolean> => {
        // 如果锁定到特定配置,不能切换
        if (lockedProfileId) {
          return false;
        }
        
        let nextIndex = profileIndex + 1;
        
        // 遍历候选配置,跳过冷却中的配置
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          
          // 检查是否在冷却中
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          
          // 尝试应用新配置
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            
            // 重置思考级别
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            
            return true;
          } catch (err) {
            // 如果是锁定配置失败,直接抛出错误
            if (candidate && candidate === lockedProfileId) {
              throw err;
            }
            nextIndex += 1;
          }
        }
        
        return false; // 没有可用的配置
      };

      // ============================================================================
      // 阶段 9: 初始认证配置选择
      // ============================================================================
      
      try {
        // 过滤出非锁定的自动配置候选
        const autoProfileCandidates = profileCandidates.filter(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.length > 0 && candidate !== lockedProfileId,
        );
        
        // 检查所有自动配置是否都在冷却中
        const allAutoProfilesInCooldown =
          autoProfileCandidates.length > 0 &&
          autoProfileCandidates.every((candidate) => isProfileInCooldown(authStore, candidate));
        
        // 解析不可用原因
        const unavailableReason = allAutoProfilesInCooldown
          ? (resolveProfilesUnavailableReason({
              store: authStore,
              profileIds: autoProfileCandidates,
            }) ?? "unknown")
          : null;
        
        // 允许探测冷却中的配置(仅限特定场景)
        // 用于处理临时性问题(速率限制、服务过载等)
        const allowTransientCooldownProbe =
          params.allowTransientCooldownProbe === true &&
          allAutoProfilesInCooldown &&
          (unavailableReason === "rate_limit" ||
            unavailableReason === "overloaded" ||
            unavailableReason === "billing" ||
            unavailableReason === "unknown");
        let didTransientCooldownProbe = false;

        // 选择第一个可用的配置
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          const inCooldown =
            candidate && candidate !== lockedProfileId && isProfileInCooldown(authStore, candidate);
          
          if (inCooldown) {
            // 如果允许探测冷却配置,尝试使用它
            if (allowTransientCooldownProbe && !didTransientCooldownProbe) {
              didTransientCooldownProbe = true;
              log.warn(
                `probing cooldowned auth profile for ${provider}/${modelId} due to ${unavailableReason ?? "transient"} unavailability`,
              );
            } else {
              // 跳过冷却中的配置
              profileIndex += 1;
              continue;
            }
          }
          
          // 应用选中的配置
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }
        
        // 如果没有可用的配置,抛出错误
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        // 处理初始化错误
        if (err instanceof FailoverError) {
          throw err;
        }
        
        // 如果锁定配置失败,直接抛出错误
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        
        // 尝试切换到下一个配置
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      // ============================================================================
      // 阶段 10: 主执行循环准备
      // ============================================================================
      
      // Copilot 认证错误后重试的辅助函数
      const maybeRefreshCopilotForAuthError = async (
        errorText: string,
        retried: boolean,
      ): Promise<boolean> => {
        if (!copilotTokenState || retried) {
          return false;
        }
        if (!isFailoverErrorMessage(errorText)) {
          return false;
        }
        if (classifyFailoverReason(errorText) !== "auth") {
          return false;
        }
        try {
          await refreshCopilotToken("auth-error");
          scheduleCopilotRefresh();
          return true;
        } catch {
          return false;
        }
      };

      // 常量定义
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3; // 最大上下文溢出压缩尝试次数
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length); // 最大循环次数
      
      // 状态变量
      let overflowCompactionAttempts = 0; // 已执行的溢出压缩次数
      let toolResultTruncationAttempted = false; // 是否已尝试截断工具结果
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
      
      // 使用量统计累加器
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0; // 自动压缩计数
      let runLoopIterations = 0; // 循环迭代次数
      let overloadFailoverAttempts = 0; // 过载 failover 尝试次数
      
      // 标记认证配置失败的辅助函数
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
      }) => {
        const { profileId, reason } = failure;
        // 超时不标记为配置失败(是网络/模型问题,不是认证问题)
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          store: authStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
        });
      };
      
      // 解析认证配置失败原因
      const resolveAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
      ): AuthProfileFailureReason | null => {
        // 超时不应该持久化认证配置失败状态
        if (!failoverReason || failoverReason === "timeout") {
          return null;
        }
        return failoverReason;
      };
      
      // 过载 failover 前的退避处理
      // 使用指数退避避免重试风暴
      const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
        if (reason !== "overloaded") {
          return;
        }
        overloadFailoverAttempts += 1;
        const delayMs = computeBackoff(OVERLOAD_FAILOVER_BACKOFF_POLICY, overloadFailoverAttempts);
        log.warn(
          `overload backoff before failover for ${provider}/${modelId}: attempt=${overloadFailoverAttempts} delayMs=${delayMs}`,
        );
        try {
          await sleepWithAbort(delayMs, params.abortSignal);
        } catch (err) {
          // 处理中止信号
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
      };
      
      // 初始化上下文引擎
      // 上下文引擎负责会话压缩和上下文管理
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      
      // ============================================================================
      // 阶段 11: 主执行循环
      // ============================================================================
      
      try {
        let authRetryPending = false;
        let lastTurnTotal: number | undefined; // 最后一次 API 调用的总 token 数
        
        // 无限循环,直到成功或达到重试限制
        while (true) {
          // -----------------------------------------------------------------------
          // 检查重试限制
          // -----------------------------------------------------------------------
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            return {
              payloads: [
                {
                  text:
                    "Request failed after repeated internal retries. " +
                    "Please try again, or use /new to start a fresh session.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: params.sessionId,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastTurnTotal,
                }),
                error: { kind: "retry_limit", message },
              },
            };
          }
          runLoopIterations += 1;
          
          const copilotAuthRetry = authRetryPending;
          authRetryPending = false;
          attemptedThinking.add(thinkLevel);
          
          // 确保工作目录存在
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          const prompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;

          const attempt = await runEmbeddedAttempt({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            senderIsOwner: params.senderIsOwner,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            contextEngine,
            contextTokenBudget: ctxInfo.tokens,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            disableTools: params.disableTools,
            provider,
            modelId,
            model: applyLocalNoAuthHeaderOverride(effectiveModel, apiKeyInfo),
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            authStorage,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult,
            thinkLevel,
            fastMode: params.fastMode,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: params.extraSystemPrompt,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          });

          const {
            aborted,
            promptError,
            timedOut,
            timedOutDuringCompaction,
            sessionIdUsed,
            lastAssistant,
          } = attempt;
          bootstrapPromptWarningSignaturesSeen =
            attempt.bootstrapPromptWarningSignaturesSeen ??
            (attempt.bootstrapPromptWarningSignature
              ? Array.from(
                  new Set([
                    ...bootstrapPromptWarningSignaturesSeen,
                    attempt.bootstrapPromptWarningSignature,
                  ]),
                )
              : bootstrapPromptWarningSignaturesSeen);
          const lastAssistantUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // Keep prompt size from the latest model call so session totalTokens
          // reflects current context usage, not accumulated tool-loop usage.
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          const activeErrorContext = resolveActiveErrorContext({
            lastAssistant,
            provider,
            model: modelId,
          });
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = describeUnknownError(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // Prompt submission failed with a non-overflow error. Do not
                  // inspect prior assistant errors from history for this attempt.
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return { text: assistantErrorText, source: "assistantError" as const };
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
                `error=${errorText.slice(0, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;
            // If this attempt already compacted (SDK auto-compaction), avoid immediately
            // running another explicit compaction for the same overflow trigger.
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              continue;
            }
            // Attempt explicit overflow compaction only when this attempt did not
            // already auto-compact.
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              // When the engine owns compaction, hooks are not fired inside
              // compactEmbeddedPiSessionDirect (which is bypassed).  Fire them
              // here so subscribers (memory extensions, usage trackers) are
              // notified even on overflow-recovery compactions.
              const overflowEngineOwnsCompaction = contextEngine.info.ownsCompaction === true;
              const overflowHookRunner = overflowEngineOwnsCompaction ? hookRunner : null;
              if (overflowHookRunner?.hasHooks("before_compaction")) {
                try {
                  await overflowHookRunner.runBeforeCompaction(
                    { messageCount: -1, sessionFile: params.sessionFile },
                    hookCtx,
                  );
                } catch (hookErr) {
                  log.warn(
                    `before_compaction hook failed during overflow recovery: ${String(hookErr)}`,
                  );
                }
              }
              try {
                compactResult = await contextEngine.compact({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionFile: params.sessionFile,
                  tokenBudget: ctxInfo.tokens,
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  force: true,
                  compactionTarget: "budget",
                  runtimeContext: {
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    agentAccountId: params.agentAccountId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderIsOwner: params.senderIsOwner,
                    provider,
                    model: modelId,
                    runId: params.runId,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    ownerNumbers: params.ownerNumbers,
                    trigger: "overflow",
                    ...(observedOverflowTokens !== undefined
                      ? { currentTokenCount: observedOverflowTokens }
                      : {}),
                    diagId: overflowDiagId,
                    attempt: overflowCompactionAttempts,
                    maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                  },
                });
              } catch (compactErr) {
                log.warn(
                  `contextEngine.compact() threw during overflow recovery for ${provider}/${modelId}: ${String(compactErr)}`,
                );
                compactResult = { ok: false, compacted: false, reason: String(compactErr) };
              }
              if (
                compactResult.ok &&
                compactResult.compacted &&
                overflowHookRunner?.hasHooks("after_compaction")
              ) {
                try {
                  await overflowHookRunner.runAfterCompaction(
                    {
                      messageCount: -1,
                      compactedCount: -1,
                      tokenCount: compactResult.result?.tokensAfter,
                      sessionFile: params.sessionFile,
                    },
                    hookCtx,
                  );
                } catch (hookErr) {
                  log.warn(
                    `after_compaction hook failed during overflow recovery: ${String(hookErr)}`,
                  );
                }
              }
              if (compactResult.compacted) {
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            // Fallback: try truncating oversized tool results in the session.
            // This handles the case where a single tool result exceeds the
            // context window and compaction cannot reduce it further.
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                  })
                : false;

              if (hasOversized) {
                if (log.isEnabled("debug")) {
                  log.debug(
                    `[compaction-diag] decision diagId=${overflowDiagId} branch=truncate_tool_results ` +
                      `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                      `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                  );
                }
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: params.sessionFile,
                  contextWindowTokens,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  // Do NOT reset overflowCompactionAttempts here — the global cap must remain
                  // enforced across all iterations to prevent unbounded compaction cycles (OC-65).
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              } else if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=${hasOversized} ` +
                    `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
            }
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS ||
                toolResultTruncationAttempted) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                error: { kind, message: errorText },
              },
            };
          }

          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            if (await maybeRefreshCopilotForAuthError(errorText, copilotAuthRetry)) {
              authRetryPending = true;
              continue;
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            // Handle image size errors with a user-friendly message (no retry needed)
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason = classifyFailoverReason(errorText);
            const promptProfileFailureReason =
              resolveAuthProfileFailureReason(promptFailoverReason);
            await maybeMarkAuthProfileFailure({
              profileId: lastProfileId,
              reason: promptProfileFailureReason,
            });
            const promptFailoverFailure = isFailoverErrorMessage(errorText);
            // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
            const failedPromptProfileId = lastProfileId;
            const logPromptFailoverDecision = createFailoverDecisionLogger({
              stage: "prompt",
              runId: params.runId,
              rawError: errorText,
              failoverReason: promptFailoverReason,
              profileFailureReason: promptProfileFailureReason,
              provider,
              model: modelId,
              profileId: failedPromptProfileId,
              fallbackConfigured,
              aborted,
            });
            if (
              promptFailoverFailure &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              logPromptFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // Throw FailoverError for prompt-side failover reasons when fallbacks
            // are configured so outer model fallback can continue on overload,
            // rate-limit, auth, or billing failures.
            if (fallbackConfigured && promptFailoverFailure) {
              const status = resolveFailoverStatus(promptFailoverReason ?? "unknown");
              logPromptFailoverDecision("fallback_model", { status });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
              });
            }
            if (promptFailoverFailure || promptFailoverReason) {
              logPromptFailoverDecision("surface_error");
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const billingFailure = isBillingAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const assistantProfileFailureReason =
            resolveAuthProfileFailureReason(assistantFailoverReason);
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");
          // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
          const failedAssistantProfileId = lastProfileId;
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            stage: "assistant",
            runId: params.runId,
            rawError: lastAssistant?.errorMessage?.trim(),
            failoverReason: assistantFailoverReason,
            profileFailureReason: assistantProfileFailureReason,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            profileId: failedAssistantProfileId,
            fallbackConfigured,
            timedOut,
            aborted,
          });

          if (
            authFailure &&
            (await maybeRefreshCopilotForAuthError(
              lastAssistant?.errorMessage ?? "",
              copilotAuthRetry,
            ))
          ) {
            authRetryPending = true;
            continue;
          }
          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          // Rotate on timeout to try another account/model path in this turn,
          // but exclude post-prompt compaction timeouts (model succeeded; no profile issue).
          const shouldRotate =
            (!aborted && failoverFailure) || (timedOut && !timedOutDuringCompaction);

          if (shouldRotate) {
            if (lastProfileId) {
              const reason = timedOut ? "timeout" : assistantProfileFailureReason;
              // Skip cooldown for timeouts: a timeout is model/network-specific,
              // not an auth issue. Marking the profile would poison fallback models
              // on the same provider (e.g. gpt-5.3 timeout blocks gpt-5.2).
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason,
              });
              if (timedOut && !isProbeSession) {
                log.warn(`Profile ${lastProfileId} timed out. Trying next account...`);
              }
              if (cloudCodeAssistFormatError) {
                log.warn(
                  `Profile ${lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
                );
              }
            }

            const rotated = await advanceAuthProfile();
            if (rotated) {
              logAssistantFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              continue;
            }

            if (fallbackConfigured) {
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              // Prefer formatted error message (user-friendly) over raw errorMessage
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                      provider: activeErrorContext.provider,
                      model: activeErrorContext.model,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : billingFailure
                      ? formatBillingErrorMessage(
                          activeErrorContext.provider,
                          activeErrorContext.model,
                        )
                      : authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              logAssistantFailoverDecision("fallback_model", { status });
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                profileId: lastProfileId,
                status,
              });
            }
            logAssistantFailoverDecision("surface_error");
          }

          const usage = toNormalizedUsage(usageAccumulator);
          if (usage && lastTurnTotal && lastTurnTotal > 0) {
            usage.total = lastTurnTotal;
          }
          // Extract the last individual API call's usage for context-window
          // utilization display. The accumulated `usage` sums input tokens
          // across all calls (tool-use loops, compaction retries), which
          // overstates the actual context size. `lastCallUsage` reflects only
          // the final call, giving an accurate snapshot of current context.
          const lastCallUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const promptTokens = derivePromptTokens(lastRunPromptUsage);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
            lastCallUsage: lastCallUsage ?? undefined,
            promptTokens,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
          };

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
          });

          // Timeout aborts can leave the run without any assistant payloads.
          // Emit an explicit timeout error instead of silently completing, so
          // callers do not lose the turn as an orphaned user message.
          if (timedOut && !timedOutDuringCompaction && payloads.length === 0) {
            return {
              payloads: [
                {
                  text:
                    "Request timed out before a response was generated. " +
                    "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }
          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              // Handle client tool calls (OpenResponses hosted tools)
              // Propagate the LLM stop reason so callers (lifecycle events,
              // ACP bridge) can distinguish end_turn from max_tokens.
              stopReason: attempt.clientToolCall
                ? "tool_calls"
                : attempt.yieldDetected
                  ? "end_turn"
                  : (lastAssistant?.stopReason as string | undefined),
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        await contextEngine.dispose?.();
        stopCopilotRefreshTimer();
        process.chdir(prevCwd);
      }
    }),
  );
}
