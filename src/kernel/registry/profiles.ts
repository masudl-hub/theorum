/**
 * Runtime profile registry for host-owned THEORUM profiles.
 *
 * THEORUM ships profile types and defaults, not application profiles. Host apps
 * register their profiles at process startup or test setup.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import type { Profile } from '../types.ts';

const profiles = new Map<string, Profile>();

/** Host-authored profile definition, with defaults applied to omitted sections. */
export type ProfileDefinition = {
  id: Profile['id'];
  identity?: Partial<Profile['identity']>;
  model: Partial<Profile['model']> & Pick<Profile['model'], 'allow'>;
  tools?: Partial<Profile['tools']>;
  inputs?: Partial<Profile['inputs']>;
  outputs?: Partial<Profile['outputs']>;
  guardrails?: Partial<Profile['guardrails']>;
};

/** Backwards-compatible alias for callers using the older name. */
export type DefineProfileInput = ProfileDefinition;

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

function buildDefaultModel(model: DefineProfileInput['model']): Profile['model'] {
  return {
    protocol: model.protocol ?? 'geminiInteractions',
    provider: model.provider ?? 'google',
    allow: model.allow,
    thinking: model.thinking ?? 'minimal',
    controls: model.controls ?? [],
    maxSteps: model.maxSteps ?? 1,
    key: model.key ?? 'freeA',
    select: model.select,
    override: model.override,
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
    media: outputs?.media ?? false,
    voice: outputs?.voice,
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
function defineProfile(input: DefineProfileInput): Profile {
  return {
    id: input.id,
    identity: buildDefaultIdentity(input.id, input.identity),
    model: buildDefaultModel(input.model),
    tools: { allow: input.tools?.allow ?? [] },
    inputs: buildDefaultInputs(input.inputs),
    outputs: buildDefaultOutputs(input.outputs),
    guardrails: buildDefaultGuardrails(input.guardrails),
  };
}

/** Register one host-owned profile in the process-local registry. */
function registerProfile(profileInput: Profile | ProfileDefinition): void {
  const profile = defineProfile(profileInput);
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = profile.inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`);
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
