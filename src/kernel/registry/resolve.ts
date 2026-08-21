import { TheorumError } from '../../guardrails/error.ts';
import { resolveGeminiBucket } from '../../guardrails/keys.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import {
  assertImageGrounding,
  resolveImageFormat,
  resolveInputParts,
} from '../../providers/media.ts';
import { mintCanary } from '../engine/boundary.ts';
import type {
  BuiltinToolId,
  CustomToolId,
  ModelId,
  Profile,
  ResolvedGeneration,
  StructuredSchemaId,
  ThinkingLevel,
  ToolId,
  TurnRequest,
} from '../types.ts';
import { CATALOG, clampThinkingLevel } from './catalog.ts';
import { getProfile } from './profiles.ts';

const BUILTINS: BuiltinToolId[] = ['googleSearch', 'googleMaps', 'urlContext'];

function applySearchXorMaps(requested: BuiltinToolId[]): BuiltinToolId[] {
  const search = requested.includes('googleSearch');
  const maps = requested.includes('googleMaps');
  if (search && maps) {
    return requested.filter((id) => id !== 'googleMaps');
  }
  return requested;
}

function firstSelectKey(selectMap: Record<string, ModelId>): string | undefined {
  const [key] = Object.keys(selectMap);
  return key;
}

function lookupSelectId(profile: Profile, select?: string): ModelId | undefined {
  const { select: selectMap } = profile.model;
  if (!selectMap) {
    return undefined;
  }
  let key = select;
  if (!key) {
    key = firstSelectKey(selectMap);
  }
  if (!key) {
    return undefined;
  }
  return selectMap[key];
}

function pickModel(profile: Profile, select?: string): ModelId {
  if (profile.model.select) {
    const id = lookupSelectId(profile, select);
    if (!(id && profile.model.allow.includes(id))) {
      let label = '';
      if (select) {
        label = select;
      }
      throw new TheorumError(`Unknown model select '${label}' for ${profile.id}`);
    }
    return id;
  }
  const [only] = profile.model.allow;
  if (!only) {
    throw new TheorumError(`Profile ${profile.id} has no models`);
  }
  return only;
}

function thinkingFromControl(modelId: ModelId, thinkingOn: boolean | undefined): ThinkingLevel {
  const catalog = CATALOG.models[modelId];
  if (thinkingOn) {
    return catalog.thinking.on;
  }
  return catalog.thinking.off;
}

function pinnedLevel(
  pinned: Record<string, ThinkingLevel>,
  key: string | undefined,
): ThinkingLevel | undefined {
  if (!key) {
    return undefined;
  }
  return pinned[key];
}

function thinkingFromPin(profile: Profile, select?: string): ThinkingLevel {
  const pinned = profile.model.thinking;
  if (typeof pinned === 'string') {
    return pinned;
  }
  if (!pinned) {
    throw new TheorumError(`Profile ${profile.id} must pin thinking or list it in controls`);
  }
  const fromSelect = pinnedLevel(pinned, select);
  if (fromSelect) {
    return fromSelect;
  }
  const fromFirst = pinnedLevel(pinned, firstSelectKey(profile.model.select ?? {}));
  if (fromFirst) {
    return fromFirst;
  }
  throw new TheorumError(`Profile ${profile.id} must pin thinking or list it in controls`);
}

function resolveThinking(
  profile: Profile,
  modelId: ModelId,
  thinkingOn: boolean | undefined,
  select?: string,
): ThinkingLevel {
  const raw = profile.model.controls?.includes('thinking')
    ? thinkingFromControl(modelId, thinkingOn)
    : thinkingFromPin(profile, select);
  return clampThinkingLevel(modelId, raw);
}

function resolveSummaries(
  profile: Profile,
  modelId: ModelId,
  thinkingOn: boolean | undefined,
): 'auto' | 'none' {
  const override = profile.model.override?.[modelId]?.summaries;
  if (override) {
    return override;
  }
  const catalog = CATALOG.models[modelId];
  if (profile.model.controls?.includes('thinking')) {
    if (thinkingOn) {
      return catalog.summaries.on;
    }
    return catalog.summaries.off;
  }
  return catalog.summaries.on;
}

function isGatedOn(requested: Partial<Record<ToolId, boolean>> | undefined, id: ToolId): boolean {
  if (!requested) {
    return false;
  }
  return requested[id] === true;
}

function resolveBuiltins(
  profile: Profile,
  requested?: Partial<Record<ToolId, boolean>>,
): BuiltinToolId[] {
  const allowed = profile.tools.allow.filter(
    (id): id is BuiltinToolId => CATALOG.tools[id].kind === 'builtin',
  );
  const picked = BUILTINS.filter((id) => allowed.includes(id) && isGatedOn(requested, id));
  return applySearchXorMaps(picked);
}

function resolveCustom(
  profile: Profile,
  requested?: Partial<Record<ToolId, boolean>>,
): CustomToolId[] {
  return profile.tools.allow.filter(
    (id): id is CustomToolId => CATALOG.tools[id].kind === 'custom' && isGatedOn(requested, id),
  );
}

function assertToolAllowed(profile: Profile, name: ToolId): void {
  if (!profile.tools.allow.includes(name)) {
    throw new TheorumError(`Tool '${name}' is not allowed on ${profile.id}`);
  }
}

function assertHandoffTarget(profile: Profile, to: string): void {
  const legal = profile.inputs.slots?.handoff;
  if (!legal?.includes(to)) {
    throw new TheorumError(`Handoff target '${to}' is not on ${profile.id}`);
  }
}

function resolveStructured(
  profile: Profile,
  slots?: Record<string, string>,
): StructuredSchemaId | null {
  const { structured } = profile.outputs;
  if (!structured) {
    return null;
  }
  if (typeof structured === 'string') {
    return structured;
  }
  const value = slots?.[structured.by];
  if (value) {
    const mapped = structured.map[value];
    if (mapped) {
      return mapped;
    }
  }
  return structured.fallback;
}

function generationLimits(
  profile: Profile,
  model: ModelId,
): {
  maxOutputTokens: number;
  temperature: number;
} {
  const catalog = CATALOG.models[model];
  const ov = profile.model.override?.[model];
  return {
    maxOutputTokens: ov?.maxOutputTokens ?? catalog.maxOutputTokens,
    temperature: ov?.temperature ?? catalog.temperature,
  };
}

function resolveTurn(req: TurnRequest): {
  profile: Profile;
  generation: ResolvedGeneration;
} {
  const safe = sanitizeTurnRequest(req);
  const profile = getProfile(safe.profile);
  const model = pickModel(profile, safe.select);
  const thinkingOn = safe.thinking === true;
  const limits = generationLimits(profile, model);
  const builtins = resolveBuiltins(profile, safe.tools);
  assertImageGrounding(model, builtins);
  return {
    profile,
    generation: {
      model,
      thinking: resolveThinking(profile, model, thinkingOn, safe.select),
      summaries: resolveSummaries(profile, model, thinkingOn),
      maxOutputTokens: limits.maxOutputTokens,
      temperature: limits.temperature,
      builtins,
      custom: resolveCustom(profile, safe.tools),
      dynamicTools: safe.dynamicTools,
      history: safe.input.history,
      maxSteps: profile.model.maxSteps ?? 1,
      structured: resolveStructured(profile, safe.input.slots),
      image: resolveImageFormat(profile, model, safe.input.slots),
      voice: profile.outputs.voice,
      input: resolveInputParts(profile, model, safe),
      geminiBucket: resolveGeminiBucket(profile.model.key ?? 'portfolio', model, builtins),
      canary: profile.guardrails.canary !== false ? mintCanary() : '',
    },
  };
}

function primaryImageSpec(allow: ModelId[]) {
  const [primary] = allow;
  if (!primary) {
    return null;
  }
  return CATALOG.models[primary].image ?? null;
}

/** UI projection: catalog ∩ profile. Swatches are not included. */
function projectProfile(id: Profile['id']) {
  const profile = getProfile(id);
  const { model, identity, tools, inputs, outputs } = profile;
  const { select, allow, maxSteps, controls } = model;
  const { handle, chat } = identity;
  const { slots } = inputs;
  return {
    id: profile.id,
    handle,
    chat: chat !== false,
    maxSteps: maxSteps ?? 1,
    models: allow,
    select: select ?? null,
    controls: controls ?? [],
    tools: tools.allow.map((name) => ({
      name,
      ...CATALOG.tools[name],
    })),
    inputs,
    slots: slots ?? {},
    outputs,
    image: primaryImageSpec(allow),
  };
}

function pickSystemRole(profile: Profile, requested?: string): string {
  const { identity } = profile;
  const { handle, systemByRole } = identity;
  if (requested && systemByRole && Object.hasOwn(systemByRole, requested)) {
    return requested;
  }
  return handle;
}

export { assertHandoffTarget, assertToolAllowed, pickSystemRole, projectProfile, resolveTurn };
