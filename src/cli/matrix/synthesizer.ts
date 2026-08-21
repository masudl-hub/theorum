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

export function synthesizeStressCombo(
  profile: Profile,
  options: { preferMaps?: boolean } = {},
): TurnRequest {
  const { inputs, tools, model } = profile;

  // 1. Select highest reasoning mode
  let select: string | undefined;
  if (model.select?.smart) {
    select = 'smart';
  } else if (model.select) {
    const keys = Object.keys(model.select);
    select = keys[keys.length - 1];
  }

  // 2. Resolve tools with conflict prevention (search XOR maps)
  const allowed = tools.allow ?? [];
  const activeTools: Partial<Record<ToolId, boolean>> = {};

  const hasSearch = allowed.includes('googleSearch');
  const hasMaps = allowed.includes('googleMaps');

  for (const t of allowed) {
    activeTools[t] = true;
  }

  if (hasSearch && hasMaps) {
    if (options.preferMaps) {
      activeTools.googleSearch = false;
      activeTools.googleMaps = true;
    } else {
      activeTools.googleSearch = true;
      activeTools.googleMaps = false;
    }
  }

  // 3. Multimodal inputs
  const attachments: TurnBlob[] = [];
  const voice: TurnBlob[] = [];

  if (inputs.attachments?.accept && inputs.attachments.accept.length > 0) {
    const accept = inputs.attachments.accept;
    const preferredMimes = ['image/png', 'application/pdf', 'text/plain'];
    const chosenMime = preferredMimes.find((m) => accept.includes(m)) ?? accept[0];
    const fixture = getFixtureForMime(chosenMime);
    if (fixture) {
      attachments.push(fixture);
    } else {
      attachments.push({ mimeType: 'image/png', data: FIXTURE_PNG_BASE64 });
    }
  }

  if (inputs.voice?.accept && inputs.voice.accept.length > 0) {
    voice.push({ mimeType: 'audio/wav', data: FIXTURE_WAV_BASE64 });
  }

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

export function buildCustomTurnRequest(profile: Profile, options: MatrixOptions): TurnRequest {
  if (options.lite) {
    return synthesizeLiteCombo(profile);
  }

  const base = synthesizeStressCombo(profile);
  if (options.mode) {
    base.select = options.mode;
  }

  if (options.search !== undefined || options.map !== undefined) {
    base.tools = base.tools ?? {};
    if (options.search !== undefined) {
      base.tools.googleSearch = options.search;
    }
    if (options.map !== undefined) {
      base.tools.googleMaps = options.map;
    }
    // Enforce search XOR maps
    if (base.tools.googleSearch && base.tools.googleMaps) {
      if (options.map) {
        base.tools.googleSearch = false;
      } else {
        base.tools.googleMaps = false;
      }
    }
  }

  return base;
}
