/**
 * THEORUM public API.
 *
 * Import this entrypoint when an application wants the complete kernel surface:
 * profile registration, turn execution, provider constructors, guardrails,
 * observability sinks, and public type contracts.
 *
 * @example
 * ```ts
 * import { defineProfile, registerProfile, runTurn } from "jsr:@theorum/core";
 *
 * const profile = defineProfile({
 *   id: "assistant.basic",
 *   model: {
 *     allow: ["gemini35FlashLite"],
 *     config: {
 *       gemini35FlashLite: {
 *         apiId: "gemini-3.5-flash-lite",
 *         thinking: { on: "high", off: "minimal" },
 *         thinkingLevels: ["minimal", "low", "medium", "high"],
 *         summaries: { on: "auto", off: "none" },
 *         maxOutputTokens: 8192,
 *         temperature: 1,
 *         keyBuiltins: [],
 *       },
 *     },
 *   },
 *   tools: { allow: [] },
 *   inputs: { text: true },
 *   outputs: {},
 *   guardrails: { quota: { perDay: 100 } },
 * });
 *
 * registerProfile(profile);
 * ```
 *
 * @module
 */

export {
  describeError,
  isAbortError,
  publicError,
  TheorumError,
  throwIfAborted,
  toErrorEvent,
} from './src/guardrails/error.ts';
export type { QuotaSlotStatus } from './src/guardrails/quota.ts';
export {
  clientIp,
  quotaMessage,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './src/guardrails/quota.ts';
export {
  PROJECT_ID_MAX,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
} from './src/guardrails/sanitize.ts';
export type { CompactionSplit, CompactionTokens } from './src/kernel/engine/compaction.ts';
export {
  compactionMeter,
  compactionNeeded,
  estimateHistoryTokens,
  HISTORY_MEDIA_TOKENS,
  HISTORY_TEXT_ENCODING,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from './src/kernel/engine/compaction.ts';
export { runTurn } from './src/kernel/engine/runner.ts';
export {
  CATALOG,
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  getTool,
  listBuiltinIds,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  registerTools,
  requireModelSpec,
  resetTools,
} from './src/kernel/registry/catalog.ts';
export type { ProfileDefinition } from './src/kernel/registry/profiles.ts';
export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from './src/kernel/registry/profiles.ts';
export { projectProfile, resolveTurn } from './src/kernel/registry/resolve.ts';
export { getStructured, registerStructured } from './src/kernel/registry/schemas.ts';
export { executeTool } from './src/kernel/registry/tools.ts';
export type {
  ProfileResumeSpec,
  TurnContinueFrom,
  TurnStop,
  TurnStopKind,
} from './src/kernel/stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION,
  DEFAULT_AUTO_CONTINUE,
  GenerationStopError,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenRouter,
} from './src/kernel/stop.ts';
export type * from './src/kernel/types.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
  writeTrace,
} from './src/observability/trace.ts';
export type { TraceRecord } from './src/observability/trace-record.ts';
export type {
  CreateProviderOptions,
  GeminiTransport,
  GeminiVault,
  LocalProviderConfig,
} from './src/providers/mod.ts';
export {
  createLocalProvider,
  createProvider,
  DEFAULT_LOCAL_BASE_URL,
} from './src/providers/mod.ts';
