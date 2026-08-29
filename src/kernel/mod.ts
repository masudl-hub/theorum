/**
 * Profile, turn, tool, provider, egress, and event contracts for THEORUM.
 *
 * This entrypoint is type-first. Host applications import from here when they
 * want to declare profiles, tool schemas, provider adapters, turn requests, or
 * trace-safe event handlers without importing provider implementations.
 *
 * @module
 */

export { compactionNeeded, splitForCompaction } from './engine/compaction.ts';
export type { CompactionSplit } from './engine/compaction.ts';
export { runTurn } from './engine/runner.ts';
export {
  CATALOG,
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  geminiKindForMime,
  getTool,
  listBuiltinIds,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  registerTools,
  requireModelSpec,
  resetTools,
} from './registry/catalog.ts';
export type { ProfileDefinition } from './registry/profiles.ts';
export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from './registry/profiles.ts';
export { projectProfile, resolveTurn } from './registry/resolve.ts';
export { getStructured, registerStructured } from './registry/schemas.ts';
export { executeTool } from './registry/tools.ts';
export type * from './types.ts';
