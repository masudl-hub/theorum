import { TheorumError } from '../../guardrails/error.ts';
import type { Profile } from '../types.ts';

const profiles = new Map<string, Profile>();

export type DefineProfileInput = {
  id: Profile['id'];
  identity?: Partial<Profile['identity']>;
  model: Partial<Profile['model']> & Pick<Profile['model'], 'allow'>;
  tools?: Partial<Profile['tools']>;
  inputs?: Partial<Profile['inputs']>;
  outputs?: Partial<Profile['outputs']>;
  guardrails: Profile['guardrails'];
};

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
    protocol: model.protocol ?? 'interactions',
    provider: model.provider ?? 'google',
    allow: model.allow,
    thinking: model.thinking ?? 'minimal',
    controls: model.controls ?? [],
    maxSteps: model.maxSteps ?? 1,
    key: model.key ?? 'portfolio',
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
    slots: inputs?.slots,
  };
}

function buildDefaultOutputs(outputs?: Partial<Profile['outputs']>): Profile['outputs'] {
  return {
    structured: outputs?.structured ?? null,
    media: outputs?.media ?? false,
    commit: outputs?.commit ?? 'artifact',
    voice: outputs?.voice,
    validation: outputs?.validation,
    streaming: outputs?.streaming,
  };
}

function buildDefaultGuardrails(guardrails: Profile['guardrails']): Profile['guardrails'] {
  return {
    quota: guardrails.quota,
    canary: guardrails.canary ?? true,
    sanitizeInput: guardrails.sanitizeInput ?? true,
    redactSensitive: guardrails.redactSensitive ?? true,
  };
}

/** Define a typed Profile with defaults for optional properties */
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

function registerProfile(profile: Profile): void {
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = profile.inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`);
    }
  }
  profiles.set(profile.id, profile);
}

function registerProfiles(profilesList: Profile[]): void {
  for (const p of profilesList) {
    registerProfile(p);
  }
}

function hasProfile(id: string): boolean {
  return profiles.has(id);
}

function listProfiles(): Profile[] {
  return Array.from(profiles.values());
}

function clearProfiles(): void {
  profiles.clear();
}

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
