/**
 * Runtime vocabulary and field catalog for THEORUM profile types.
 *
 * Closed unions live here as `as const` arrays; TypeScript types are derived
 * from those arrays. Host UIs and docs import this module (no Deno APIs) so
 * dropdowns and hover tips stay in lockstep with the kernel.
 *
 * @module
 */

/** Model reasoning effort level normalized across provider adapters. */
export const THINKING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Wire protocol for a profile. */
export const PROTOCOLS = ['geminiInteractions', 'openAi'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Transport provider for a profile. */
export const PROVIDERS = ['google', 'openrouter', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Legal `createProvider` pairs. Keep this table in lockstep with the factory.
 * Keys are protocols; values are the providers that protocol may bind.
 */
export const PROTOCOL_PROVIDERS = {
  geminiInteractions: ['google'],
  openAi: ['openrouter', 'local'],
} as const satisfies Record<Protocol, readonly Provider[]>;

/** Named Gemini key bucket used by host-provided transports. */
export const GEMINI_BUCKETS = ['freeA', 'freeB', 'freeC', 'paid'] as const;
export type GeminiBucket = (typeof GEMINI_BUCKETS)[number];

/** Gemini bucket that may overflow to the paid bucket after quota backoff. */
export const GEMINI_FREE_BUCKETS = ['freeA', 'freeB', 'freeC'] as const satisfies readonly Exclude<
  GeminiBucket,
  'paid'
>[];
export type GeminiFreeBucket = (typeof GEMINI_FREE_BUCKETS)[number];

/** Profile-level control a caller may toggle at turn time. */
export const CONTROL_IDS = ['thinking'] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

/** Normalized multimodal part category. */
export const MEDIA_INPUT_KIND_VALUES = ['image', 'audio', 'video', 'document'] as const;
export type MediaInputKind = (typeof MEDIA_INPUT_KIND_VALUES)[number];

/** Provider thinking-summary behavior. */
export const SUMMARY_MODES = ['auto', 'none'] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

/** Stream delivery mode. */
export const STREAM_MODES = ['sse', 'buffered'] as const;
export type StreamMode = (typeof STREAM_MODES)[number];

/** Audio container for speech generation output. */
export const SPEECH_AUDIO_FORMATS = ['pcm', 'mp3'] as const;
export type SpeechAudioFormat = (typeof SPEECH_AUDIO_FORMATS)[number];

/** Structured-output enforcement mode. */
export const SCHEMA_ENFORCEMENTS = ['responseFormat', 'prompt'] as const;
export type SchemaEnforcement = (typeof SCHEMA_ENFORCEMENTS)[number];

/** Compaction threshold meter. */
export const COMPACTION_METERS = ['history', 'input'] as const;
export type CompactionMeter = (typeof COMPACTION_METERS)[number];

/** When compaction runs relative to the primary turn. */
export const COMPACTION_TIMINGS = ['before', 'after'] as const;
export type CompactionTiming = (typeof COMPACTION_TIMINGS)[number];

/** Egress block handling. */
export const EGRESS_ON_BLOCK = ['reject_to_agent', 'refuse_to_user'] as const;
export type EgressOnBlock = (typeof EGRESS_ON_BLOCK)[number];

/** Why a turn ended (provider-neutral). */
export const TURN_STOP_KINDS = [
  'completed',
  'length',
  'tool',
  'filtered',
  'provider_error',
  'cancelled',
  'stream_incomplete',
] as const;
export type TurnStopKind = (typeof TURN_STOP_KINDS)[number];

/** Tool visibility tier used by host dynamic-loading strategies. */
export const TOOL_LOAD_TIERS = ['T0', 'T1', 'T2'] as const;
export type ToolLoadTier = (typeof TOOL_LOAD_TIERS)[number];

/** Execution authorization tier for dynamic tools. */
export const TOOL_PERMISSION_TIERS = ['auto', 'session_consent', 'always_confirm'] as const;
export type ToolPermissionTier = (typeof TOOL_PERMISSION_TIERS)[number];

/** MIME essence → normalized media part category (shared ingress map). */
export const MEDIA_INPUT_KINDS: Record<string, MediaInputKind> = {
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

/** Type-prefix wildcards accepted by `mimeAllowed`. */
export const MEDIA_WILDCARDS = ['image/*', 'audio/*', 'video/*'] as const;

function mimesOf(kind: MediaInputKind): string[] {
  return Object.keys(MEDIA_INPUT_KINDS).filter((mime) => MEDIA_INPUT_KINDS[mime] === kind);
}

/** Attachment `accept` values the kernel can classify (wildcards + known types). */
export const ATTACHMENT_ACCEPT_MIMES: readonly string[] = [
  'image/*',
  'video/*',
  ...mimesOf('image'),
  ...mimesOf('video'),
  ...mimesOf('document'),
];

/** Voice `accept` values the kernel can classify (wildcard + known audio types). */
export const VOICE_ACCEPT_MIMES: readonly string[] = ['audio/*', ...mimesOf('audio')];

/** Providers allowed for a protocol. */
export function providersFor(protocol: Protocol): readonly Provider[] {
  return PROTOCOL_PROVIDERS[protocol];
}

/** Protocols allowed for a provider. */
export function protocolsFor(provider: Provider): readonly Protocol[] {
  const found: Protocol[] = [];
  for (const protocol of PROTOCOLS) {
    if ((PROTOCOL_PROVIDERS[protocol] as readonly Provider[]).includes(provider)) {
      found.push(protocol);
    }
  }
  return found;
}

/** True when `createProvider` will accept this pair. */
export function isValidPair(protocol: Protocol, provider: Provider): boolean {
  return (PROTOCOL_PROVIDERS[protocol] as readonly Provider[]).includes(provider);
}

/** When protocol changes, snap provider to a valid partner. */
export function coerceProvider(protocol: Protocol, provider: Provider): Provider {
  const allowed = providersFor(protocol);
  const [first] = allowed;
  return allowed.includes(provider) ? provider : first;
}

/** When provider changes, snap protocol to a valid partner. */
export function coerceProtocol(protocol: Protocol, provider: Provider): Protocol {
  const allowed = protocolsFor(provider);
  const [first] = allowed;
  return allowed.includes(protocol) ? protocol : first;
}

function unionType(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' | ');
}

/** Metadata for one profile (or adjacent) field, used by docs/UI hover. */
export type FieldMeta = {
  type: string;
  doc: string;
  options?: readonly string[];
  optionDescriptions?: Record<string, string>;
  optionNote?: string;
};

function field(
  type: string,
  doc: string,
  options?: readonly string[],
  optionDescriptionsOrNote?: Record<string, string> | string,
  optionNote?: string,
): FieldMeta {
  if (options) {
    if (typeof optionDescriptionsOrNote === 'object') {
      return optionNote
        ? { type, doc, options, optionDescriptions: optionDescriptionsOrNote, optionNote }
        : { type, doc, options, optionDescriptions: optionDescriptionsOrNote };
    }
    if (typeof optionDescriptionsOrNote === 'string') {
      return { type, doc, options, optionNote: optionDescriptionsOrNote };
    }
    return { type, doc, options };
  }
  return { type, doc };
}

/**
 * Parents whose next key is a host-owned map key (model id, slot name, …).
 * The annotator substitutes `*` so `model.config.flash.apiId` → `model.config.*.apiId`.
 */
export const DYNAMIC_FIELD_PARENTS: ReadonlySet<string> = new Set([
  'model.config',
  'model.select',
  'model.thinking',
  'identity.systemByRole',
  'inputs.slots',
  'inputs.limitsByMime',
  'outputs.validation.fields',
]);

/** Resolve a key stack from authored source into a catalog path. */
export function catalogPathFor(keys: readonly string[]): string {
  const resolved: string[] = [];
  for (const key of keys) {
    const prefix = resolved.join('.');
    if (DYNAMIC_FIELD_PARENTS.has(prefix)) {
      resolved.push('*');
    } else {
      resolved.push(key);
    }
  }
  return resolved.join('.');
}

/**
 * Authoring-surface catalog for `Profile` / `defineProfile`.
 * Hover UIs look up dotted paths. Adding a profile field? Add it here.
 */
export const PROFILE_FIELDS: Record<string, FieldMeta> = {
  id: field('string', 'Host-owned profile identifier.'),
  identity: field(
    '{ handle, chat?, system?, systemByRole? }',
    'Display handle, chat flag, and system instruction the model receives each turn.',
  ),
  'identity.handle': field('string', 'Public handle for this agent.'),
  'identity.chat': field('boolean', 'When true, this profile is a conversational agent.'),
  'identity.system': field('string', 'System instruction merged into every turn.'),
  'identity.systemByRole': field(
    'Record<string, string>',
    'Optional system instruction keyed by turn role.',
  ),
  'identity.systemByRole.*': field(
    'string',
    'System instruction merged when this turn role is active.',
  ),
  model: field('ProfileModelSpec', 'Protocol, provider, allowlist, wire config, and step bounds.'),
  'model.protocol': field(
    unionType(PROTOCOLS),
    'Wire protocol. Pairs with provider via createProvider.',
    PROTOCOLS,
    {
      geminiInteractions: 'Google Gemini Interactions wire protocol (Gemini 2.5 / 3+).',
      openAi: 'OpenAI-compatible chat completions and streaming protocol.',
    },
  ),
  'model.provider': field(
    unionType(PROVIDERS),
    'Transport. Must form a legal pair with protocol.',
    PROVIDERS,
    {
      google: 'Direct Google Gemini API transport.',
      openrouter: 'OpenRouter multi-provider API proxy.',
      local: 'Local OpenAI-compatible server (Ollama, llama.cpp, vLLM).',
    },
  ),
  'model.allow': field('ModelId[]', 'Ids this profile may select. Each id must exist in config.'),
  'model.config': field(
    'Record<ModelId, ModelSpec>',
    'Host-owned wire config keyed by the same ids used in allow / select.',
  ),
  'model.config.*': field(
    'ModelSpec',
    'Host-owned wire config for this model id (apiId, thinking, token limits, compaction).',
  ),
  'model.config.*.apiId': field('string', 'Provider wire model id.'),
  'model.config.*.thinking': field(
    '{ on, off }',
    'Thinking levels used when a boolean thinking control is on or off.',
  ),
  'model.config.*.thinking.on': field(
    unionType(THINKING_LEVELS),
    'Level when thinking is on.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.thinking.off': field(
    unionType(THINKING_LEVELS),
    'Level when thinking is off.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.thinkingLevels': field(
    'ThinkingLevel[]',
    'Levels this model accepts. Illegal values are clamped.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.config.*.summaries': field('{ on, off }', 'Summary behavior for the thinking control.'),
  'model.config.*.summaries.on': field(
    unionType(SUMMARY_MODES),
    'Summaries when thinking is on.',
    SUMMARY_MODES,
    {
      auto: 'Emit thinking summaries when available.',
      none: 'Suppress thinking summaries from the stream.',
    },
  ),
  'model.config.*.summaries.off': field(
    unionType(SUMMARY_MODES),
    'Summaries when thinking is off.',
    SUMMARY_MODES,
    {
      auto: 'Emit thinking summaries when available.',
      none: 'Suppress thinking summaries from the stream.',
    },
  ),
  'model.config.*.maxOutputTokens': field('number', 'Maximum tokens the model may emit.'),
  'model.config.*.temperature': field('number', 'Sampling temperature.'),
  'model.config.*.keyBuiltins': field(
    'BuiltinToolId[]',
    'Builtins that may use profile.model.key. Any other enabled builtin selects paid.',
  ),
  'model.config.*.key': field(
    unionType(GEMINI_BUCKETS),
    'Optional vault slot for this model. Overrides profile.model.key.',
    GEMINI_BUCKETS,
  ),
  'model.config.*.compaction': field(
    'CompactionSpec',
    'Optional compaction policy for this model.',
  ),
  'model.config.*.compaction.maxTokens': field(
    'number',
    'Token budget compared by the trigger (compactAt * maxTokens).',
  ),
  'model.config.*.compaction.compactAt': field(
    'number',
    'Fraction of maxTokens at which compaction fires. Must be in (0, 1).',
  ),
  'model.config.*.compaction.previousExchanges': field(
    'number',
    '≥ 1 = exchange count, (0, 1) = fraction of maxTokens, 0 = compact all.',
  ),
  'model.config.*.compaction.profile': field(
    'ProfileId',
    'Compaction agent profile id. Must be registered before the owning profile.',
  ),
  'model.config.*.compaction.timing': field(
    unionType(COMPACTION_TIMINGS),
    'When compaction runs relative to the primary turn.',
    COMPACTION_TIMINGS,
    {
      before: 'Compact synchronously before running the turn request.',
      after: 'Signal on done for host async background compaction.',
    },
  ),
  'model.config.*.compaction.meter': field(
    unionType(COMPACTION_METERS),
    'What the threshold meters. Defaults to history.',
    COMPACTION_METERS,
    {
      history: 'Meters token count across prior conversation turns.',
      input: 'Meters full turn input token count (system + history + attachments).',
    },
  ),
  'model.select': field(
    'Record<string, ModelId>',
    'Named aliases (fast / smart) → allowlisted ids.',
  ),
  'model.select.*': field('ModelId', 'Allowlisted model id for this select key.'),
  'model.thinking': field(
    'ThinkingLevel | Record<string, ThinkingLevel>',
    'Default thinking pin, or a map keyed by select labels.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.thinking.*': field(
    unionType(THINKING_LEVELS),
    'Thinking pin for this select key.',
    THINKING_LEVELS,
    {
      none: 'Disable reasoning tokens completely.',
      minimal: 'Minimal reasoning tokens for fastest response.',
      low: 'Low reasoning budget for basic structured tasks.',
      medium: 'Balanced reasoning for multi-step agent actions.',
      high: 'Deep reasoning for complex planning and code.',
      xhigh: 'Extended reasoning budget for hard problems.',
      max: 'Maximum reasoning tokens supported by model.',
    },
  ),
  'model.controls': field('ControlId[]', 'Turn-time toggles this profile exposes.', CONTROL_IDS),
  'model.maxSteps': field('number', 'Tool-loop ceiling. Defaults to 1.'),
  'model.key': field(
    unionType(GEMINI_FREE_BUCKETS),
    'Gemini vault slot for Google Interactions. Paid is overflow-only.',
    GEMINI_FREE_BUCKETS,
  ),
  tools: field(
    '{ allow: ToolId[] }',
    'Hard ceiling — the turn cannot enable tools outside this list.',
  ),
  'tools.allow': field('ToolId[]', 'Maximum set of tools the agent may call.'),
  inputs: field('ProfileInputsSpec', 'Text, attachment, voice, slot, and size rules.'),
  'inputs.text': field('boolean', 'Whether the profile accepts text on a turn. Defaults to true.'),
  'inputs.attachments': field('{ accept: string[] }', 'File upload allowlist.'),
  'inputs.attachments.accept': field(
    'string[]',
    'MIME allowlist for uploaded files. Type-prefix wildcards (image/*, …) are allowed.',
    ATTACHMENT_ACCEPT_MIMES,
    'Kernel-known types (plus wildcards). Hosts may list any MIME; unknown types are rejected at ingress.',
  ),
  'inputs.voice': field(
    '{ accept: string[] }',
    'Voice ingress block — not a bare string. Use accept for audio MIME allowlist.',
  ),
  'inputs.voice.accept': field(
    'string[]',
    'MIME allowlist for voice blobs. audio/* wildcards are allowed.',
    VOICE_ACCEPT_MIMES,
    'Kernel-known audio types (plus audio/*).',
  ),
  'inputs.maxFiles': field(
    'number',
    'Max files per turn. Required when attachments or voice is set.',
  ),
  'inputs.maxBytes': field(
    'number',
    'Max bytes per file. Required when attachments or voice is set.',
  ),
  'inputs.maxTurnBytes': field(
    'number',
    'Max total bytes per turn. Required when attachments or voice is set.',
  ),
  'inputs.limitsByMime': field('Record<string, number>', 'Optional per-MIME byte caps.'),
  'inputs.limitsByMime.*': field('number', 'Maximum byte limit for files of this MIME type.'),
  'inputs.slots': field(
    'Record<string, string[]>',
    'Optional turn-time selectors (e.g. aspectRatio: ["1:1", "16:9"]).',
  ),
  'inputs.slots.*': field('string[]', 'Allowed choices for this turn selector.'),
  outputs: field(
    'ProfileOutputsSpec',
    'Structured, image, speech, validation, streaming, and resume pins.',
  ),
  'outputs.structured': field(
    'StructuredSchemaId | StructuredBySlot | null',
    'Registered schema id, slot-mapped ids, or null for free text.',
  ),
  'outputs.image': field(
    'ProfileImageSpec',
    'Pins for an image-role profile. Model id is on model.',
  ),
  'outputs.image.aspectRatio': field(
    'string',
    'Default aspect ratio when the turn does not set slots.aspectRatio.',
  ),
  'outputs.image.size': field(
    'string',
    'Default size / resolution when the turn does not set slots.size.',
  ),
  'outputs.image.mimeType': field('string', 'Output MIME for generated images.'),
  'outputs.image.allowsGrounding': field(
    'boolean',
    'When false, grounding builtins are rejected on this profile.',
  ),
  'outputs.image.maxInputImages': field('number', 'Cap on reference images in one turn.'),
  'outputs.speech': field('ProfileSpeechSpec', 'TTS pins. Model id is on model.'),
  'outputs.speech.voice': field(
    'string',
    'TTS voice id (outputs.speech). Kernel accepts any string; Google preset narrows to named voices.',
  ),
  'outputs.speech.format': field(
    unionType(SPEECH_AUDIO_FORMATS),
    'pcm (default) → WAV on both transports. mp3 requires protocol openAi.',
    SPEECH_AUDIO_FORMATS,
    {
      pcm: 'Raw 24kHz 16-bit PCM audio (→ WAV container). Supported by Google and OpenAI.',
      mp3: 'MP3 encoded stream. Requires openAi protocol.',
    },
  ),
  'outputs.validation': field('ProfileValidationSpec', 'Host domain validators and repair policy.'),
  'outputs.validation.fields': field(
    'Record<string, ProfileValidator>',
    'Validators keyed by dotted paths into structured output (e.g. diagram.mermaid).',
  ),
  'outputs.validation.fields.*': field(
    '(source: unknown) => { isValid: boolean; error?: string }',
    'Host-owned validator function for this structured output field.',
  ),
  'outputs.validation.maxRetries': field('number', 'Repair-turn ceiling after a validator reject.'),
  'outputs.validation.repairGuidance': field(
    'string',
    'Instruction appended on a validation repair turn.',
  ),
  'outputs.streaming': field('ProfileStreamingSpec', 'How the turn emits live events.'),
  'outputs.streaming.mode': field(
    unionType(STREAM_MODES),
    'sse (default) or buffered.',
    STREAM_MODES,
    {
      sse: 'Server-Sent Events emitting live incremental TurnEvents.',
      buffered: 'Buffers response into a single completed turn event.',
    },
  ),
  'outputs.streaming.streamThoughts': field('boolean', 'Emit model thinking on the turn stream.'),
  'outputs.streaming.gateMedia': field('boolean', 'Hold media until egress / validation clear.'),
  'outputs.resume': field('ProfileResumeSpec', 'Continue after a non-user stop.'),
  'outputs.resume.allowContinue': field(
    'TurnStopKind[]',
    'Kinds eligible for a Continue / continueFrom turn.',
    TURN_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
      tool: 'Turn paused at tool execution boundary.',
      filtered: 'Content safety filter intercepted output.',
      cancelled: 'Turn aborted via AbortSignal.',
      completed: 'Turn finished normally.',
    },
  ),
  'outputs.resume.autoContinue': field(
    'TurnStopKind[]',
    'Kinds the host may auto-continue once without a CTA.',
    TURN_STOP_KINDS,
    {
      length: 'Model hit maximum output token ceiling.',
      stream_incomplete: 'Network connection or stream dropped prematurely.',
      provider_error: 'Upstream provider returned an error code or timeout.',
      tool: 'Turn paused at tool execution boundary.',
      filtered: 'Content safety filter intercepted output.',
      cancelled: 'Turn aborted via AbortSignal.',
      completed: 'Turn finished normally.',
    },
  ),
  guardrails: field(
    'ProfileGuardrailsSpec',
    'Quota, canary, sanitize, redact, and egress switches.',
  ),
  'guardrails.quota': field(
    '{ perDay: number }',
    'Host HTTP helper — not enforced inside runTurn.',
  ),
  'guardrails.quota.perDay': field('number', 'Daily turn cap used by host quota middleware.'),
  'guardrails.canary': field('boolean', 'Per-turn canary token. Defaults to true.'),
  'guardrails.sanitizeInput': field('boolean', 'Strip inbound injection spans. Defaults to true.'),
  'guardrails.redactSensitive': field('boolean', 'Redact sensitive spans. Defaults to true.'),
  'guardrails.egress': field(
    'ProfileEgressSpec',
    'Host check before user-visible text is released.',
  ),
  'guardrails.egress.enforce': field(
    'EgressEnforcer',
    'Host function: (context) => { blocked, text, … }.',
  ),
  'guardrails.egress.onBlock': field(
    unionType(EGRESS_ON_BLOCK),
    'reject_to_agent retries; refuse_to_user stops the turn.',
    EGRESS_ON_BLOCK,
    {
      reject_to_agent: 'Feeds rejection error back to model for automatic repair turn.',
      refuse_to_user: 'Halts turn immediately and returns refusal to user.',
    },
  ),
  'guardrails.egress.maxRetries': field('number', 'Repair-turn ceiling after an egress block.'),
  'guardrails.egress.repairGuidance': field(
    'string',
    'Instruction appended on an egress repair turn.',
  ),
};

/** Adjacent turn / dynamic-tool fields that appear next to profile examples. */
export const EXTRA_FIELDS: Record<string, FieldMeta> = {
  loadTier: field(
    unionType(TOOL_LOAD_TIERS),
    'Dynamic tool visibility strategy (host-owned).',
    TOOL_LOAD_TIERS,
    {
      T0: 'Always loaded on every turn.',
      T1: 'Loaded conditionally based on turn context.',
      T2: 'Deferred until requested dynamically by agent.',
    },
  ),
  permissionTier: field(
    unionType(TOOL_PERMISSION_TIERS),
    'When the host must confirm before executing this tool.',
    TOOL_PERMISSION_TIERS,
    {
      auto: 'Executes automatically without user prompt.',
      session_consent: 'Prompt user once per session for consent.',
      always_confirm: 'Prompt user before every tool execution.',
    },
  ),
  dynamicTools: field(
    'DynamicToolDeclaration[]',
    'Runtime tool declarations on the turn request — not on the profile.',
  ),
  parameters: field('Record<string, unknown>', 'JSON Schema fragment sent to the provider.'),
  handler: field(
    '(args) => ToolEnvelope | Promise<ToolEnvelope>',
    'Host function that executes this dynamic tool.',
  ),
};

/** Look up hover metadata for a dotted path (profile first, then extra). */
export function fieldMeta(path: string): FieldMeta | undefined {
  return PROFILE_FIELDS[path] ?? EXTRA_FIELDS[path];
}
