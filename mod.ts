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
 *   model: { allow: ["gemini35FlashLite"] },
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

export { publicError, TheorumError } from './src/guardrails/error.ts';
export {
  PROJECT_ID_MAX,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
} from './src/guardrails/sanitize.ts';
export { runTurn } from './src/kernel/engine/runner.ts';
export {
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
export {
  createInteractionsProvider,
  createOpenRouterProvider,
  createOpenRouterTtsProvider,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  streamOpenRouterTts,
  toOpenRouterPayload,
  wrapPcmAsWav,
} from './src/providers/mod.ts';
