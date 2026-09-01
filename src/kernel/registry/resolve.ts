/**
 * Profile resolution for THEORUM turns.
 *
 * This module validates caller overrides, selects models and tools, normalizes
 * input parts, and produces the provider request state consumed by `runTurn`.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { mintCanary } from '../engine/boundary.ts';
import type {
  BuiltinToolId,
  CustomToolId,
  ModelId,
  ModelSpec,
  Profile,
  ProjectedProfile,
  ProviderTransport,
  ResolvedGeneration,
  StructuredSchemaId,
  ThinkingLevel,
  ToolId,
  TurnRequest,
} from '../types.ts';
import {
  CATALOG,
  clampThinkingLevel,
  getTool,
  listBuiltinIds,
  requireModelSpec,
} from './catalog.ts';
import {
  assertImageGrounding,
  assertSpeechRole,
  resolveImageFormat,
  resolveInputParts,
} from './ingress.ts';
import { getProfile } from './profiles.ts';
import { resolveGeminiBucket } from './vault.ts';

function applyBuiltinMutualExclusions(requested: BuiltinToolId[]): BuiltinToolId[] {
  return requested.filter((id) => {
    const conflicts = getTool(id)?.conflictsWith ?? [];
    return !conflicts.some((other) => requested.includes(other));
  });
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

function thinkingFromControl(spec: ModelSpec, thinkingOn: boolean | undefined): ThinkingLevel {
  if (thinkingOn) {
    return spec.thinking.on;
  }
  return spec.thinking.off;
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
  spec: ModelSpec,
  thinkingOn: boolean | undefined,
  select?: string,
): ThinkingLevel {
  const raw = profile.model.controls?.includes('thinking')
    ? thinkingFromControl(spec, thinkingOn)
    : thinkingFromPin(profile, select);
  return clampThinkingLevel(spec, raw);
}

function resolveSummaries(
  profile: Profile,
  spec: ModelSpec,
  thinkingOn: boolean | undefined,
): 'auto' | 'none' {
  if (profile.model.controls?.includes('thinking')) {
    if (thinkingOn) {
      return spec.summaries.on;
    }
    return spec.summaries.off;
  }
  return spec.summaries.on;
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
    (id): id is BuiltinToolId => CATALOG.tools[id]?.kind === 'builtin',
  );
  const picked = listBuiltinIds().filter((id) => allowed.includes(id) && isGatedOn(requested, id));
  return applyBuiltinMutualExclusions(picked);
}

function resolveCustom(
  profile: Profile,
  requested?: Partial<Record<ToolId, boolean>>,
): CustomToolId[] {
  return profile.tools.allow.filter(
    (id): id is CustomToolId => CATALOG.tools[id]?.kind === 'custom' && isGatedOn(requested, id),
  );
}

function assertToolAllowed(profile: Profile, name: ToolId): void {
  if (!profile.tools.allow.includes(name)) {
    throw new TheorumError(`Tool '${name}' is not allowed on ${profile.id}`);
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

/** Resolve a host `TurnRequest` into provider-ready generation state. */
function resolveTurn(req: TurnRequest): {
  profile: Profile;
  generation: ResolvedGeneration;
} {
  const safe = sanitizeTurnRequest(req);
  const input = safe.input ?? {};
  const profile = getProfile(safe.profile);
  const model = pickModel(profile, safe.select);
  const spec = requireModelSpec(profile, model);
  const thinkingOn = safe.thinking === true;
  const builtins = resolveBuiltins(profile, safe.tools);
  assertImageGrounding(profile, model, builtins);
  assertSpeechRole(profile);
  const geminiBucket =
    profile.model.provider === 'google'
      ? resolveGeminiBucket(profile.model.key ?? 'freeA', spec, builtins)
      : undefined;
  const transport: ProviderTransport =
    profile.model.protocol === 'geminiInteractions' && profile.model.provider === 'google'
      ? 'interactions'
      : 'openAiCompat';
  return {
    profile,
    generation: {
      model,
      apiId: spec.apiId,
      transport,
      previousInteractionId: safe.previousInteractionId,
      store: safe.store,
      stream: safe.stream,
      thinking: resolveThinking(profile, spec, thinkingOn, safe.select),
      summaries: resolveSummaries(profile, spec, thinkingOn),
      maxOutputTokens: spec.maxOutputTokens,
      temperature: spec.temperature,
      builtins,
      custom: resolveCustom(profile, safe.tools),
      dynamicTools: safe.dynamicTools,
      dynamicToolLoader: safe.dynamicToolLoader,
      sessionPermissions: safe.sessionPermissions,
      history: input.history,
      maxSteps: profile.model.maxSteps ?? 1,
      structured: resolveStructured(profile, input.slots),
      image: resolveImageFormat(profile, model, input.slots),
      speech: profile.outputs.speech,
      input: resolveInputParts(profile, model, safe),
      geminiBucket,
      canary: profile.guardrails.canary !== false ? mintCanary() : '',
    },
  };
}

function primaryImageSpec(profile: Profile) {
  return profile.outputs.image;
}

/** Project a registered profile into a safe host/UI inspection object. */
function projectProfile(id: Profile['id']): ProjectedProfile {
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
      ...(CATALOG.tools[name] ?? { kind: 'custom' as const, ui: true }),
    })),
    inputs,
    slots: slots ?? {},
    outputs,
    image: primaryImageSpec(profile),
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

export { assertToolAllowed, pickSystemRole, projectProfile, resolveTurn };
