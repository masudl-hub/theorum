/**
 * Tool catalog and MIME helpers.
 *
 * Model wire metadata is host-owned on `profile.model.config`. This module only
 * keeps builtin/custom tool descriptors and shared MIME utilities.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { MEDIA_INPUT_KINDS } from '../schema.ts';
import type {
  BuiltinToolId,
  Catalog,
  MediaInputKind,
  ModelId,
  ModelSpec,
  Profile,
  ThinkingLevel,
  ToolCatalogEntry,
  ToolId,
} from '../types.ts';

const ASK_USER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['confirm', 'choice', 'text'] },
    prompt: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'prompt'],
};

/** Harness tools that always ship with THEORUM. */
const HARNESS_TOOLS: Record<ToolId, ToolCatalogEntry> = {
  askUser: { kind: 'custom', ui: true, schema: ASK_USER_SCHEMA },
};

/** Live tool catalog. Starts with harness tools; presets/hosts register more. */
const CATALOG: Catalog = {
  tools: { ...HARNESS_TOOLS },
};

/** Register or replace tool descriptors (idempotent per id). */
function registerTools(entries: Record<string, ToolCatalogEntry>): void {
  Object.assign(CATALOG.tools, entries);
}

/** Look up one registered tool descriptor. */
function getTool(id: ToolId): ToolCatalogEntry | undefined {
  return CATALOG.tools[id];
}

/** Ids of all registered provider builtins. */
function listBuiltinIds(): BuiltinToolId[] {
  return Object.entries(CATALOG.tools)
    .filter(([, entry]) => entry.kind === 'builtin')
    .map(([id]) => id);
}

/** Restore harness-only tools (tests / host reloads). */
function resetTools(): void {
  for (const id of Object.keys(CATALOG.tools)) {
    delete CATALOG.tools[id];
  }
  Object.assign(CATALOG.tools, HARNESS_TOOLS);
}

function mimeEssence(mime: string): string {
  const [base] = mime.split(';');
  return (base ?? '').trim().toLowerCase();
}

function mimeAllowed(accept: string[], mime: string): boolean {
  const actual = mimeEssence(mime);
  return accept.some((rule) => {
    const allowed = mimeEssence(rule);
    if (allowed.endsWith('/*')) {
      return actual.startsWith(allowed.slice(0, -1));
    }
    return allowed === actual;
  });
}

function mediaKindForMime(mime: string): MediaInputKind | undefined {
  return MEDIA_INPUT_KINDS[mimeEssence(mime)];
}

/** Require a host-declared model spec for an allowed profile model id. */
function requireModelSpec(profile: Profile, modelId: ModelId): ModelSpec {
  const spec = profile.model.config[modelId];
  if (!spec) {
    throw new TheorumError(`Profile ${profile.id} has no model spec for '${modelId}'`);
  }
  return spec;
}

function clampLevels(entry: ModelSpec | undefined, level: ThinkingLevel): ThinkingLevel {
  if (!entry?.thinkingLevels || entry.thinkingLevels.length === 0) {
    return level;
  }
  if (entry.thinkingLevels.includes(level)) {
    return level;
  }
  const fallback = entry.thinking.off;
  if (entry.thinkingLevels.includes(fallback)) {
    return fallback;
  }
  const first = entry.thinkingLevels[0];
  return first ?? level;
}

/** Clamp a requested thinking level to what the model spec accepts. */
function clampThinkingLevel(spec: ModelSpec, level: ThinkingLevel): ThinkingLevel {
  return clampLevels(spec, level);
}

/** Look up a model spec by provider-native API id within a host specs map. */
function modelEntryByApiId(specs: Record<string, ModelSpec>, apiId: string): ModelSpec | undefined {
  return Object.values(specs).find((m) => m.apiId === apiId);
}

/** Clamp thinking level using a provider-native API id within a host specs map. */
function clampThinkingLevelForApiId(
  specs: Record<string, ModelSpec>,
  apiId: string,
  level: ThinkingLevel,
): ThinkingLevel {
  return clampLevels(modelEntryByApiId(specs, apiId), level);
}

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
};
