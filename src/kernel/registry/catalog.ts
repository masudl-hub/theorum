import type {
  Catalog,
  GeminiInputKind,
  ImageAspectRatio,
  ImageSize,
  ModelCatalogEntry,
  ThinkingLevel,
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

const DEFAULT_TEMPERATURE = 1;
const FLASH_LITE_MAX_OUTPUT_TOKENS = 8192;
const PRO_PREVIEW_MAX_OUTPUT_TOKENS = 64_000;
const FLASH_37_MAX_OUTPUT_TOKENS = 64_000;
const IMAGE_FLASH_LITE_MAX_OUTPUT_TOKENS = 4096;
const TTS_FLASH_MAX_OUTPUT_TOKENS = 2048;
const SONAR_MAX_OUTPUT_TOKENS = 8192;

const IMAGE_INPUT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const VOICE_INPUT_MIMES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'];

const KIB = 1024;
const MIB = KIB * KIB;
/** Default chat media caps. Profiles copy these; mermaid overrides `maxFiles`. */
const CHAT_MEDIA_LIMITS = {
  maxFiles: 10,
  maxBytes: 8 * MIB,
  maxTurnBytes: 32 * MIB,
} as const;

/** Gemini Interactions inline MIME → part type. Profiles allowlist from this set. */
const GEMINI_INPUT_KINDS: Record<string, GeminiInputKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/aiff': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/pcm': 'audio',
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  'video/x-flv': 'video',
  'video/mpg': 'video',
  'video/webm': 'video',
  'video/wmv': 'video',
  'video/x-ms-wmv': 'video',
  'video/3gpp': 'video',
  'application/pdf': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'text/markdown': 'document',
  'text/html': 'document',
  'application/json': 'document',
};

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

function geminiKindForMime(mime: string): GeminiInputKind | undefined {
  return GEMINI_INPUT_KINDS[mimeEssence(mime)];
}

const IMAGE_FLASH_LITE_ASPECT_RATIOS: ImageAspectRatio[] = [
  '1:1',
  '3:2',
  '2:3',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
];

const IMAGE_FLASH_LITE_SIZES: ImageSize[] = ['1K'];

const FLASH_LITE_THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
const FLASH_37_THINKING_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];
const PRO_PREVIEW_THINKING_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];
const IMAGE_FLASH_LITE_THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'high'];
const TTS_THINKING_LEVELS: ThinkingLevel[] = ['minimal'];
const OPENROUTER_SEARCH_THINKING_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];

const GENERIC_MODEL_ENTRY: ModelCatalogEntry = {
  apiId: '',
  thinking: { on: 'high', off: 'low' },
  thinkingLevels: ['low', 'medium', 'high'],
  summaries: { on: 'auto', off: 'none' },
  maxOutputTokens: FLASH_LITE_MAX_OUTPUT_TOKENS,
  temperature: DEFAULT_TEMPERATURE,
  freeBuiltins: [],
};

const CATALOG: Catalog = {
  models: {
    gemini31FlashLite: {
      apiId: 'gemini-3.1-flash-lite',
      thinking: { on: 'high', off: 'minimal' },
      thinkingLevels: FLASH_LITE_THINKING_LEVELS,
      summaries: { on: 'auto', off: 'none' },
      maxOutputTokens: FLASH_LITE_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: ['googleMaps', 'urlContext'],
    },
    gemini31ProPreview: {
      apiId: 'gemini-3.1-pro-preview',
      thinking: { on: 'high', off: 'low' },
      thinkingLevels: PRO_PREVIEW_THINKING_LEVELS,
      summaries: { on: 'auto', off: 'none' },
      maxOutputTokens: PRO_PREVIEW_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: [],
    },
    gemini35FlashLite: {
      apiId: 'gemini-3.5-flash-lite',
      thinking: { on: 'high', off: 'minimal' },
      thinkingLevels: FLASH_LITE_THINKING_LEVELS,
      summaries: { on: 'auto', off: 'none' },
      maxOutputTokens: FLASH_LITE_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: ['googleMaps', 'urlContext'],
    },
    gemini37Flash: {
      apiId: 'gemini-3.7-flash',
      // Default is medium; off cannot be minimal (400).
      thinking: { on: 'high', off: 'low' },
      thinkingLevels: FLASH_37_THINKING_LEVELS,
      summaries: { on: 'auto', off: 'auto' },
      maxOutputTokens: FLASH_37_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: ['urlContext'],
    },
    gemini31FlashLiteImage: {
      apiId: 'gemini-3.1-flash-lite-image',
      thinking: { on: 'high', off: 'minimal' },
      thinkingLevels: IMAGE_FLASH_LITE_THINKING_LEVELS,
      summaries: { on: 'none', off: 'none' },
      maxOutputTokens: IMAGE_FLASH_LITE_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: [],
      image: {
        maxInputImages: 14,
        inputMimes: IMAGE_INPUT_MIMES,
        sizes: IMAGE_FLASH_LITE_SIZES,
        aspectRatios: IMAGE_FLASH_LITE_ASPECT_RATIOS,
        outputMime: 'image/jpeg',
        allowsGrounding: false,
      },
    },
    gemini31FlashTts: {
      apiId: 'gemini-3.1-flash-tts-preview',
      thinking: { on: 'minimal', off: 'minimal' },
      thinkingLevels: TTS_THINKING_LEVELS,
      summaries: { on: 'none', off: 'none' },
      maxOutputTokens: TTS_FLASH_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: [],
    },
    sonar: {
      apiId: 'sonar',
      openRouterId: 'perplexity/sonar',
      thinking: { on: 'high', off: 'low' },
      thinkingLevels: OPENROUTER_SEARCH_THINKING_LEVELS,
      summaries: { on: 'none', off: 'none' },
      maxOutputTokens: SONAR_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      freeBuiltins: [],
    },
  },
  // Off until the turn sets tools[id]. Profile allow is only the ceiling.
  tools: {
    googleSearch: { kind: 'builtin', ui: true },
    googleMaps: { kind: 'builtin', ui: true },
    urlContext: { kind: 'builtin', ui: true },
    askUser: { kind: 'custom', ui: true, schema: ASK_USER_SCHEMA },
    generateMedia: {
      kind: 'custom',
      ui: true,
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          kind: { type: 'string', enum: ['image'] },
        },
        required: ['prompt'],
      },
    },
    writeArtifact: { kind: 'custom', ui: true, schema: { type: 'object' } },
    validate: { kind: 'custom', ui: true, schema: { type: 'object' } },
    analyze: { kind: 'custom', ui: true, schema: { type: 'object' } },
    commit: { kind: 'custom', ui: true, schema: { type: 'object' } },
    handoff: {
      kind: 'custom',
      ui: true,
      schema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['to'],
      },
    },
  },
};

export {
  CATALOG,
  CHAT_MEDIA_LIMITS,
  GEMINI_INPUT_KINDS,
  geminiKindForMime,
  IMAGE_FLASH_LITE_ASPECT_RATIOS,
  IMAGE_FLASH_LITE_SIZES,
  IMAGE_INPUT_MIMES,
  mimeAllowed,
  mimeEssence,
  VOICE_INPUT_MIMES,
};

export const MODEL_CATALOG = CATALOG.models;

export function modelEntry(modelId: string): ModelCatalogEntry {
  return (
    MODEL_CATALOG[modelId as keyof typeof MODEL_CATALOG] ?? {
      ...GENERIC_MODEL_ENTRY,
      apiId: modelId,
      openRouterId: modelId,
    }
  );
}

function clampLevels(entry: ModelCatalogEntry | undefined, level: ThinkingLevel): ThinkingLevel {
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

/** Clamp a requested thinking level to what the selected model accepts. */
export function clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
  return clampLevels(modelEntry(modelId), level);
}

export function modelEntryByApiId(apiId: string): ModelCatalogEntry | undefined {
  return Object.values(MODEL_CATALOG).find((m) => m.apiId === apiId);
}

export function clampThinkingLevelForApiId(apiId: string, level: ThinkingLevel): ThinkingLevel {
  const entry = modelEntryByApiId(apiId);
  return clampLevels(entry, level);
}
