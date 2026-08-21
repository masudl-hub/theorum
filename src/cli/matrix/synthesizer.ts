import type { Profile, ToolId, TurnBlob, TurnRequest } from '../../kernel/types.ts';
import { FIXTURE_PNG_BASE64, FIXTURE_WAV_BASE64, getFixtureForMime } from './fixtures.ts';

export interface MatrixOptions {
  lite?: boolean;
  search?: boolean;
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

function resolveStressTools(
  allowed: ToolId[],
  preferMaps: boolean | undefined,
): Partial<Record<ToolId, boolean>> {
  const activeTools: Partial<Record<ToolId, boolean>> = {};
  const hasSearch = allowed.includes('googleSearch');
  const hasMaps = allowed.includes('googleMaps');
  const hasUrl = allowed.includes('urlContext');

  for (const t of allowed) {
    activeTools[t] = true;
  }

  if (hasMaps && preferMaps) {
    activeTools.googleSearch = false;
    activeTools.urlContext = false;
    activeTools.googleMaps = true;
  } else if (hasSearch || hasUrl) {
    activeTools.googleMaps = false;
    if (hasSearch) activeTools.googleSearch = true;
    if (hasUrl) activeTools.urlContext = true;
  }
  return activeTools;
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
  options: { preferMaps?: boolean } = {},
): TurnRequest {
  const select = resolveStressReasoning(profile);
  const activeTools = resolveStressTools(profile.tools.allow ?? [], options.preferMaps);
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

  // 1. Lite / connectivity
  combos.push({
    name: 'Lite (connectivity)',
    req: synthesizeLiteCombo(profile),
  });

  // 2. Stress combo (Primary)
  combos.push({
    name: 'Stress (all modalities + primary tools)',
    req: synthesizeStressCombo(profile, { preferMaps: false }),
  });

  // 3. Maps variant if both search and maps are allowed
  const allowed = profile.tools.allow ?? [];
  if (allowed.includes('googleSearch') && allowed.includes('googleMaps')) {
    combos.push({
      name: 'Maps Variant (maps enabled, search off)',
      req: synthesizeStressCombo(profile, { preferMaps: true }),
    });
  }

  return combos;
}

function applyExplicitToolOverrides(base: TurnRequest, options: MatrixOptions): void {
  base.tools = base.tools ?? {};
  if (options.search !== undefined) {
    base.tools.googleSearch = options.search;
  }
  if (options.map !== undefined) {
    base.tools.googleMaps = options.map;
  }
  // Enforce maps XOR (search | urlContext)
  if (base.tools.googleMaps && (base.tools.googleSearch || base.tools.urlContext)) {
    if (options.map) {
      base.tools.googleSearch = false;
      base.tools.urlContext = false;
    } else {
      base.tools.googleMaps = false;
    }
  }
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
    applyExplicitToolOverrides(base, options);
  }

  return base;
}
