/**
 * Stress / matrix turn synthesis for the THEORUM CLI.
 *
 * Tool enabling walks the profile allowlist and registered catalog metadata
 * (`conflictsWith`). Google `--search` / `--map` flags remain as convenience
 * aliases for `googleSearch` / `googleMaps` when those ids are allowed.
 *
 * @module
 */

import { getTool } from '../../kernel/registry/catalog.ts';
import type { Profile, ToolId, TurnBlob, TurnRequest } from '../../kernel/types.ts';
import { FIXTURE_PNG_BASE64, FIXTURE_WAV_BASE64, getFixtureForMime } from './fixtures.ts';

export interface MatrixOptions {
  lite?: boolean;
  /** Convenience alias for enabling/disabling `googleSearch` when allowed. */
  search?: boolean;
  /** Convenience alias for enabling/disabling `googleMaps` when allowed. */
  map?: boolean;
  mode?: string;
  attachmentPaths?: string[];
  voicePath?: string;
}

export function synthesizeLiteCombo(profile: Profile): TurnRequest {
  const select = profile.model.select?.fast ? 'fast' : undefined;
  return {
    profile: profile.id,
    select,
    tools: {},
    input: {
      text: `Ping test for profile ${profile.id}. Respond concisely with confirmation.`,
    },
  };
}

function resolveStressReasoning(profile: Profile): string | undefined {
  if (profile.model.select?.smart) {
    return 'smart';
  }
  if (profile.model.select) {
    const keys = Object.keys(profile.model.select);
    return keys[keys.length - 1];
  }
  return undefined;
}

function isEnabled(active: Partial<Record<ToolId, boolean>>, id: ToolId): boolean {
  return active[id] === true;
}

/** Drop tools whose registered `conflictsWith` siblings are also enabled. */
function applyRegisteredConflicts(
  allowed: ToolId[],
  active: Partial<Record<ToolId, boolean>>,
): void {
  for (const id of allowed) {
    if (!isEnabled(active, id)) {
      continue;
    }
    const conflicts = getTool(id)?.conflictsWith ?? [];
    if (conflicts.some((other) => isEnabled(active, other))) {
      active[id] = false;
    }
  }
}

/**
 * Enable allowlisted tools, optionally forcing one preferred tool and clearing
 * what it conflicts with (and tools that conflict with it).
 */
function resolveStressTools(allowed: ToolId[], prefer?: ToolId): Partial<Record<ToolId, boolean>> {
  const active: Partial<Record<ToolId, boolean>> = {};
  for (const t of allowed) {
    active[t] = true;
  }

  if (prefer && allowed.includes(prefer)) {
    active[prefer] = true;
    for (const c of getTool(prefer)?.conflictsWith ?? []) {
      if (allowed.includes(c)) {
        active[c] = false;
      }
    }
    for (const t of allowed) {
      if (t === prefer) {
        continue;
      }
      const otherConflicts: ToolId[] = getTool(t)?.conflictsWith ?? [];
      if (otherConflicts.includes(prefer)) {
        active[t] = false;
      }
    }
  }

  applyRegisteredConflicts(allowed, active);
  return active;
}

/** Builtins on the allowlist that declare conflicts (candidates for matrix variants). */
function conflictingAllowlistedTools(allowed: ToolId[]): ToolId[] {
  return allowed.filter((id) => {
    const entry = getTool(id);
    return entry?.kind === 'builtin' && (entry.conflictsWith?.length ?? 0) > 0;
  });
}

function resolveStressAttachments(profile: Profile): TurnBlob[] {
  const attachments: TurnBlob[] = [];
  const accept = profile.inputs.attachments?.accept;
  if (accept && accept.length > 0) {
    const preferredMimes = ['image/png', 'application/pdf', 'text/plain'];
    const chosenMime = preferredMimes.find((m) => accept.includes(m)) ?? accept[0];
    const fixture = getFixtureForMime(chosenMime);
    if (fixture) {
      attachments.push(fixture);
    } else {
      attachments.push({ mimeType: 'image/png', data: FIXTURE_PNG_BASE64 });
    }
  }
  return attachments;
}

function resolveStressVoice(profile: Profile): TurnBlob[] {
  const voice: TurnBlob[] = [];
  if (profile.inputs.voice?.accept && profile.inputs.voice.accept.length > 0) {
    voice.push({ mimeType: 'audio/wav', data: FIXTURE_WAV_BASE64 });
  }
  return voice;
}

export function synthesizeStressCombo(
  profile: Profile,
  options: { preferTool?: ToolId } = {},
): TurnRequest {
  const select = resolveStressReasoning(profile);
  const activeTools = resolveStressTools(profile.tools.allow ?? [], options.preferTool);
  const attachments = resolveStressAttachments(profile);
  const voice = resolveStressVoice(profile);
  const promptText = `Execute comprehensive test turn for profile ${profile.id}. Validate all instructions and produce required outputs.`;

  return {
    profile: profile.id,
    select,
    tools: activeTools,
    input: {
      text: promptText,
      attachments: attachments.length > 0 ? attachments : undefined,
      voice: voice.length > 0 ? voice : undefined,
    },
  };
}

export function synthesizeMatrixCombos(
  profile: Profile,
): Array<{ name: string; req: TurnRequest }> {
  const combos: Array<{ name: string; req: TurnRequest }> = [];
  const allowed = profile.tools.allow ?? [];

  combos.push({
    name: 'Lite (connectivity)',
    req: synthesizeLiteCombo(profile),
  });

  const primary = synthesizeStressCombo(profile);
  combos.push({
    name: 'Stress (all modalities + primary tools)',
    req: primary,
  });

  // Variants: each allowlisted conflicting builtin that the primary pass dropped.
  for (const id of conflictingAllowlistedTools(allowed)) {
    if (primary.tools?.[id] === true) {
      continue;
    }
    const variant = synthesizeStressCombo(profile, { preferTool: id });
    if (variant.tools?.[id] !== true) {
      continue;
    }
    combos.push({
      name: `Conflict variant (${id} preferred)`,
      req: variant,
    });
  }

  return combos;
}

/** Map legacy Google CLI flags onto tool ids when the profile allowlists them. */
function applyGoogleFlagAliases(
  active: Partial<Record<ToolId, boolean>>,
  allowed: ToolId[],
  options: MatrixOptions,
): void {
  if (options.search !== undefined && allowed.includes('googleSearch')) {
    active.googleSearch = options.search;
  }
  if (options.map !== undefined && allowed.includes('googleMaps')) {
    active.googleMaps = options.map;
  }
}

function applyExplicitToolOverrides(
  base: TurnRequest,
  profile: Profile,
  options: MatrixOptions,
): void {
  const allowed = profile.tools.allow ?? [];
  base.tools = base.tools ?? {};
  applyGoogleFlagAliases(base.tools, allowed, options);

  // If map was explicitly requested on, prefer it against its registered conflicts.
  if (options.map === true && allowed.includes('googleMaps')) {
    const preferred = resolveStressTools(allowed, 'googleMaps');
    for (const id of allowed) {
      base.tools[id] = preferred[id] === true;
    }
    return;
  }

  applyRegisteredConflicts(allowed, base.tools);
}

export function buildCustomTurnRequest(profile: Profile, options: MatrixOptions): TurnRequest {
  if (options.lite) {
    return synthesizeLiteCombo(profile);
  }

  const base = synthesizeStressCombo(profile);
  if (options.mode) {
    base.select = options.mode;
  }

  if (options.search !== undefined || options.map !== undefined) {
    applyExplicitToolOverrides(base, profile, options);
  }

  return base;
}
