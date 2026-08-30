/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types and defaults, not application profiles. Host apps
 * register their profiles at process startup or test setup.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import type { CompactionSpec, ModelId, Profile } from '../types.ts';

const profiles = new Map<string, Profile>();

/** Host-authored profile definition, with defaults applied to omitted sections. */
export type ProfileDefinition = {
  id: Profile['id'];
  identity?: Partial<Profile['identity']>;
  model: Partial<Profile['model']> & Pick<Profile['model'], 'allow' | 'config'>;
  tools?: Partial<Profile['tools']>;
  inputs?: Partial<Profile['inputs']>;
  outputs?: Partial<Profile['outputs']>;
  guardrails?: Partial<Profile['guardrails']>;
};

function assertModelSpecs(
  profileId: string,
  allow: ModelId[],
  config: Profile['model']['config'],
): void {
  for (const id of allow) {
    if (!config[id]) {
      throw new TheorumError(`Profile ${profileId} allowlists '${id}' without a model spec`);
    }
  }
}

function buildDefaultIdentity(
  id: Profile['id'],
  identity?: Partial<Profile['identity']>,
): Profile['identity'] {
  return {
    handle: identity?.handle ?? id,
    chat: identity?.chat,
    system: identity?.system,
    systemByRole: identity?.systemByRole,
  };
}

function buildDefaultModel(profileId: string, model: ProfileDefinition['model']): Profile['model'] {
  assertModelSpecs(profileId, model.allow, model.config);
  return {
    protocol: model.protocol ?? 'geminiInteractions',
    provider: model.provider ?? 'google',
    allow: model.allow,
    config: model.config,
    thinking: model.thinking ?? 'minimal',
    controls: model.controls ?? [],
    maxSteps: model.maxSteps ?? 1,
    key: model.key ?? 'freeA',
    select: model.select,
  };
}

function buildDefaultInputs(inputs?: Partial<Profile['inputs']>): Profile['inputs'] {
  return {
    text: inputs?.text ?? true,
    attachments: inputs?.attachments,
    voice: inputs?.voice,
    maxFiles: inputs?.maxFiles,
    maxBytes: inputs?.maxBytes,
    maxTurnBytes: inputs?.maxTurnBytes,
    limitsByMime: inputs?.limitsByMime,
    slots: inputs?.slots,
  };
}

function buildDefaultOutputs(outputs?: Partial<Profile['outputs']>): Profile['outputs'] {
  return {
    structured: outputs?.structured ?? null,
    image: outputs?.image,
    speech: outputs?.speech,
    validation: outputs?.validation,
    streaming: outputs?.streaming,
  };
}

function buildDefaultGuardrails(
  guardrails?: Partial<Profile['guardrails']>,
): Profile['guardrails'] {
  return {
    quota: guardrails?.quota,
    canary: guardrails?.canary ?? true,
    sanitizeInput: guardrails?.sanitizeInput ?? true,
    redactSensitive: guardrails?.redactSensitive ?? true,
    egress: guardrails?.egress,
  };
}

/** Define a typed profile with stable defaults for optional properties. */
function defineProfile(input: ProfileDefinition): Profile {
  return {
    id: input.id,
    identity: buildDefaultIdentity(input.id, input.identity),
    model: buildDefaultModel(input.id, input.model),
    tools: { allow: input.tools?.allow ?? [] },
    inputs: buildDefaultInputs(input.inputs),
    outputs: buildDefaultOutputs(input.outputs),
    guardrails: buildDefaultGuardrails(input.guardrails),
  };
}

function assertCompactionSpec(profileId: string, modelId: ModelId, spec: CompactionSpec): void {
  const tag = `Profile ${profileId} model ${modelId} compaction`;
  assertCompactionBudget(tag, spec);
  assertCompactionRetain(tag, spec);
  if (spec.meter != null && spec.meter !== 'history' && spec.meter !== 'input') {
    throw new TheorumError(`${tag}: meter must be 'history' or 'input'`);
  }
  if (!profiles.has(spec.profile)) {
    throw new TheorumError(
      `${tag}: compaction profile '${spec.profile}' must be registered before '${profileId}'`,
    );
  }
}

function assertCompactionBudget(tag: string, spec: CompactionSpec): void {
  if (spec.maxTokens <= 0) {
    throw new TheorumError(`${tag}: maxTokens must be > 0`);
  }
  if (spec.compactAt <= 0 || spec.compactAt >= 1) {
    throw new TheorumError(`${tag}: compactAt must be in (0, 1)`);
  }
}

function assertCompactionRetain(tag: string, spec: CompactionSpec): void {
  if (spec.previousExchanges < 0) {
    throw new TheorumError(`${tag}: previousExchanges must be >= 0`);
  }
  if (spec.previousExchanges > 0 && spec.previousExchanges < 1) {
    if (spec.previousExchanges >= spec.compactAt) {
      throw new TheorumError(
        `${tag}: previousExchanges as fraction (${spec.previousExchanges}) must be < compactAt (${spec.compactAt})`,
      );
    }
  }
  if (spec.previousExchanges >= 1 && !Number.isInteger(spec.previousExchanges)) {
    throw new TheorumError(`${tag}: previousExchanges >= 1 must be an integer`);
  }
}

/** Register one host-owned profile in the process-local registry. */
function registerProfile(profileInput: Profile | ProfileDefinition): void {
  const profile = defineProfile(profileInput);
  assertModelSpecs(profile.id, profile.model.allow, profile.model.config);
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = profile.inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`);
    }
  }
  for (const [modelId, spec] of Object.entries(profile.model.config)) {
    if (spec.compaction) {
      assertCompactionSpec(profile.id, modelId, spec.compaction);
    }
  }
  profiles.set(profile.id, profile);
}

/** Register several host-owned profiles in order. */
function registerProfiles(profilesList: Array<Profile | ProfileDefinition>): void {
  for (const p of profilesList) {
    registerProfile(p);
  }
}

/** Return whether a profile id is currently registered. */
function hasProfile(id: string): boolean {
  return profiles.has(id);
}

/** List all currently registered profiles. */
function listProfiles(): Profile[] {
  return Array.from(profiles.values());
}

/** Clear the process-local registry; intended for tests and host reloads. */
function clearProfiles(): void {
  profiles.clear();
}

/** Fetch a registered profile or throw a `TheorumError`. */
function getProfile(id: string): Profile {
  const profile = profiles.get(id);
  if (!profile) {
    throw new TheorumError(`Unknown profile '${id}'`);
  }
  return profile;
}

export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
};
