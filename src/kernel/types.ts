/**
 * Shared type contracts for THEORUM profiles, turns, provider adapters, tools,
 * guardrails, and stream events.
 *
 * Import from `jsr:@theorum/core/kernel` or `theorum/kernel` when a host app needs types without
 * importing provider implementations.
 *
 * @module
 */

/** Model reasoning effort level normalized across provider adapters. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** Built-in model aliases included in THEORUM's generic model catalog. */
export type StandardModelId =
  | 'gemini31FlashLite'
  | 'gemini31ProPreview'
  | 'gemini35FlashLite'
  | 'gemini31FlashLiteImage'
  | 'gemini31FlashTts'
  | 'sonar';

/** Any model id a host profile may allow, including app-provided custom ids. */
export type ModelId = StandardModelId | (string & {});

/** Provider-native tools THEORUM can project into supported provider payloads. */
export type BuiltinToolId = 'googleSearch' | 'googleMaps' | 'urlContext';
/** Minimal built-in custom tool available to host apps for user interaction pauses. */
export type StandardCustomToolId = 'askUser';
/** Host-owned custom tool id. */
export type CustomToolId = StandardCustomToolId | (string & {});
/** Any tool id accepted by profile allowlists and per-turn gates. */
export type ToolId = BuiltinToolId | CustomToolId;

/** Id of a host-registered structured output schema. */
export type StructuredSchemaId = string;

/** Interactions inline part types Gemini accepts besides text. */
export type GeminiInputKind = 'image' | 'audio' | 'video' | 'document';

/** Host-owned profile identifier. */
export type ProfileId = string;

/** Named Gemini key bucket used by host-provided transports. */
export type GeminiBucket = 'freeA' | 'freeB' | 'freeC' | 'paid';
/** Gemini bucket that may overflow to the paid bucket after quota backoff. */
export type GeminiFreeBucket = Exclude<GeminiBucket, 'paid'>;

/** Message role accepted by provider history mappers. */
export type ChatRole = 'system' | 'user' | 'assistant';
/** Profile-level control a caller may toggle at turn time. */
export type ControlId = 'thinking';

/** Native image size supported by the generic image response spec. */
export type ImageSize = '1K';

/** Native image aspect ratio accepted by image-capable model specs. */
export type ImageAspectRatio =
  | '1:1'
  | '3:2'
  | '2:3'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9';

/** Public event types emitted by `runTurn` and provider adapters. */
export type TurnEventType =
  | 'thought'
  | 'text'
  | 'tool'
  | 'structured'
  | 'media'
  | 'grounding'
  | 'evidence'
  | 'tokens'
  | 'done'
  | 'error';

/** Provider thinking levels used when a boolean thinking control is on or off. */
export interface ThinkingMap {
  on: ThinkingLevel;
  off: ThinkingLevel;
}

/** Provider summary behavior used when a boolean thinking control is on or off. */
export interface SummaryMap {
  on: 'auto' | 'none';
  off: 'auto' | 'none';
}

/** Native image generation on Interactions (`response_format.type = image`). */
export interface ImageModelSpec {
  maxInputImages: number;
  inputMimes: string[];
  sizes: ImageSize[];
  aspectRatios: ImageAspectRatio[];
  outputMime: string;
  allowsGrounding: boolean;
}

/** Static metadata THEORUM needs to safely call a model id. */
export interface ModelCatalogEntry {
  apiId: string;
  /** Provider-native id for OpenRouter-compatible gateways. Defaults to `google/${apiId}`. */
  openRouterId?: string;
  thinking: ThinkingMap;
  /** Levels this model accepts on Interactions. Illegal values → 400. */
  thinkingLevels: ThinkingLevel[];
  summaries: SummaryMap;
  maxOutputTokens: number;
  temperature: number;
  /** Builtins that may run on the profile's free key. Anything else is paid. */
  freeBuiltins: BuiltinToolId[];
  image?: ImageModelSpec;
}

/** Static metadata for built-in and generic custom tools. */
export interface ToolCatalogEntry {
  kind: 'builtin' | 'custom';
  ui: boolean;
  schema?: Record<string, unknown>;
}

/** Host-registered structured output schema and enforcement mode. */
export interface StructuredSpec {
  enforced: 'responseFormat' | 'prompt';
  jsonSchema?: Record<string, unknown>;
}

/** In-memory model and tool catalog shape. */
export interface Catalog {
  models: Record<ModelId, ModelCatalogEntry>;
  tools: Record<ToolId, ToolCatalogEntry>;
}

/** Per-turn file, byte, and MIME-specific input limits. */
export interface MediaLimits {
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
  limitsByMime?: Record<string, number>;
}

/** Input media declaration used by attachment and voice sanitizers. */
export interface MimeInputs extends Partial<MediaLimits> {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
}

/** Structured schema selector driven by an input slot. */
export interface StructuredBySlot {
  by: string;
  map: Record<string, string>;
  fallback: string;
}

/** Legacy-compatible model selection block used by profile builders. */
export interface ProfileModels {
  allow: ModelId[];
  select?: Record<string, ModelId>;
  /** Pinned level when `thinking` is not in `controls`. */
  thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
  override?: Partial<
    Record<
      ModelId,
      Partial<
        Pick<ModelCatalogEntry, 'maxOutputTokens' | 'temperature'> & {
          summaries?: 'auto' | 'none';
        }
      >
    >
  >;
}

/** Result returned by a profile output validator. */
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  finding?: string;
  data?: Record<string, unknown>;
}

/** Host-owned validator for structured output candidates. */
export type ProfileValidator = (
  candidate: unknown,
  slots?: Record<string, string>,
) => ValidationResult | Promise<ValidationResult>;

/** Profile output validation and deterministic repair configuration. */
export interface ProfileValidationSpec {
  extract?: (structured: unknown) => unknown;
  validate: ProfileValidator;
  maxRetries?: number;
  repairGuidance?: string;
}

/** Audio container emitted by the OpenRouter TTS adapter. */
export type OpenRouterAudioFormat = 'pcm' | 'mp3';

/** Voice name passed through to OpenRouter-compatible TTS models. */
export type OpenRouterTtsVoice =
  | 'Zephyr'
  | 'Puck'
  | 'Charon'
  | 'Kore'
  | 'Fenrir'
  | 'Leda'
  | 'Orus'
  | 'Aoede'
  | 'Callirrhoe'
  | 'Autonoe'
  | 'Enceladus'
  | 'Iapetus'
  | 'Umbriel'
  | 'Algieba'
  | 'Despina'
  | 'Erinome'
  | 'Algenib'
  | 'Rasalgethi'
  | 'Laomedeia'
  | 'Achernar'
  | 'Alnilam'
  | 'Schedar'
  | 'Gacrux'
  | 'Pulcherrima'
  | 'Achird'
  | 'Zubenelgenubi'
  | 'Vindemiatrix'
  | 'Sadachbia'
  | 'Sadaltager'
  | 'Sulafat'
  | (string & {});

/** Voice output configuration owned by the host profile. */
export interface ProfileVoiceSpec {
  voice?: OpenRouterTtsVoice;
  responseFormat?: OpenRouterAudioFormat;
}

/** Stream delivery controls enforced by the kernel. */
export interface ProfileStreamingSpec {
  mode?: 'sse' | 'buffered';
  streamThoughts?: boolean;
  gateMedia?: boolean;
}

/** Context passed to a host-owned outbound disclosure guard. */
export interface EgressContext {
  text: string;
  canary?: string;
  slots?: Record<string, string>;
  profile: Profile;
  role?: string;
}

/** Decision returned by an egress guard. */
export interface EgressEnforcementResult {
  blocked: boolean;
  text: string;
  hits?: string[];
  rejectionMessage?: string | null;
}

/** Function that evaluates candidate user-visible output before release. */
export type EgressEnforcer = (
  context: EgressContext,
) => EgressEnforcementResult | Promise<EgressEnforcementResult>;

/** Profile egress policy for rejection, retry, or refusal behavior. */
export interface ProfileEgressSpec {
  enforce: EgressEnforcer;
  onBlock?: 'reject_to_agent' | 'refuse_to_user';
  maxRetries?: number;
  repairGuidance?: string;
}

/** Profile guardrail switches enforced by the kernel. */
export interface ProfileGuardrailsSpec {
  /** Optional daily turn quota; omitted means quota enforcement is not configured. */
  quota?: { perDay: number };
  canary?: boolean;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
  egress?: ProfileEgressSpec;
}

/** Model, provider, thinking, and step bounds for a profile. */
export interface ProfileModelSpec {
  protocol: 'geminiInteractions' | 'openAi';
  provider: 'google' | 'openrouter';
  allow: ModelId[];
  select?: Record<string, ModelId>;
  thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
  controls?: ControlId[];
  maxSteps?: number;
  key?: GeminiFreeBucket;
  override?: Record<
    string,
    {
      maxOutputTokens?: number;
      temperature?: number;
      summaries?: 'auto' | 'none';
    }
  >;
}

/** Text, attachment, voice, slot, and size rules for a profile. */
export interface ProfileInputsSpec {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  limitsByMime?: Record<string, number>;
  slots?: Record<string, string[]>;
}

/** Output schema, media, voice, validation, and stream rules for a profile. */
export interface ProfileOutputsSpec {
  structured?: StructuredSchemaId | StructuredBySlot | null;
  media?: boolean;
  voice?: ProfileVoiceSpec;
  validation?: ProfileValidationSpec;
  streaming?: ProfileStreamingSpec;
}

/** Complete host-owned agent contract consumed by the kernel. */
export interface Profile {
  id: ProfileId;
  identity: {
    handle: string;
    chat?: boolean;
    system?: string;
    systemByRole?: Record<string, string>;
  };
  model: ProfileModelSpec;
  tools: { allow: ToolId[] };
  inputs: ProfileInputsSpec;
  outputs: ProfileOutputsSpec;
  guardrails: ProfileGuardrailsSpec;
}

/** Text part sent to provider adapters after input normalization. */
export interface InteractionTextPart {
  type: 'text';
  text: string;
}

/** Inline media part sent to provider adapters after MIME validation. */
export interface InteractionMediaPart {
  type: GeminiInputKind;
  mimeType: string;
  data: string;
}

/** Any provider input part accepted by THEORUM's provider contract. */
export type InteractionPart = InteractionTextPart | InteractionMediaPart;

/** Native image response request passed to image-capable providers. */
export interface ImageResponseFormat {
  type: 'image';
  mimeType: string;
  aspectRatio: ImageAspectRatio;
  imageSize: ImageSize;
}

/** Base64-encoded blob supplied by a host turn request. */
export interface TurnBlob {
  mimeType: string;
  data: string;
}

/** Provider-neutral history message preserving text, parts, tools, and metadata. */
export interface TurnHistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  parts?: InteractionPart[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    thoughtSignature?: string;
  }>;
  tool_call_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

/** Tool visibility tier used by host dynamic-loading strategies. */
export type ToolLoadTier = 'T0' | 'T1' | 'T2';
/** Execution authorization tier for dynamic tools. */
export type ToolPermissionTier = 'auto' | 'session_consent' | 'always_confirm';

/** Context supplied to a dynamic tool authorization hook. */
export interface DynamicToolExecutionContext {
  args: Record<string, unknown>;
  profile: Profile;
  sessionPermissions?: string[];
}

/** Context supplied to a host dynamic tool schema loader. */
export interface DynamicToolLoadContext {
  name: string;
  args: Record<string, unknown>;
  profile: Profile;
  currentTools: DynamicToolDeclaration[];
  sessionPermissions?: string[];
}

/** Host function that loads more tool declarations during a turn. */
export type DynamicToolLoader = (
  context: DynamicToolLoadContext,
) => DynamicToolDeclaration[] | Promise<DynamicToolDeclaration[]>;

/** Runtime tool schema and execution policy supplied by the host app. */
export interface DynamicToolDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  loadTier?: ToolLoadTier;
  permissionTier?: ToolPermissionTier;
  category?: string;
  /** Marks this declaration as a schema-loader tool for T2 expansion. */
  loadsDynamicTools?: boolean;
  handler?: (args: Record<string, unknown>) => ToolEnvelope | Promise<ToolEnvelope>;
  canExecute?: (
    context: DynamicToolExecutionContext,
  ) => boolean | Promise<boolean> | ToolEnvelope | Promise<ToolEnvelope>;
}

/** Generic repair request used for validation and egress retry turns. */
export interface TurnRepairRequest {
  previousOutput: string;
  rejection: string;
  guidance?: string;
}

/** User, media, history, and repair payload for a turn. */
export interface TurnInput {
  text?: string;
  role?: string;
  slots?: Record<string, string>;
  attachments?: TurnBlob[];
  voice?: TurnBlob[];
  history?: TurnHistoryMessage[];
  repair?: TurnRepairRequest;
}

/** Host request after kernel ingress normalization. */
export type NormalizedTurnRequest = TurnRequest & { input: TurnInput };

/** Host request for a single deterministic agent turn. */
export interface TurnRequest {
  profile: ProfileId;
  /** Caller project id when one exists. Omitted on some HTTP hosts. */
  projectId?: string;
  /** Google Interactions server-side conversation state. Omit for stateless/manual history. */
  previousInteractionId?: string;
  /** Optional Interactions storage override. Omit to let provider/project policy decide. */
  store?: boolean;
  select?: string;
  thinking?: boolean;
  /** Host-provided dynamic system prompt combined with profile persona */
  system?: string;
  /** Session permissions granted for this conversation turn */
  sessionPermissions?: string[];
  /** Opt-in gates. Profile `allow` is the ceiling; a tool is off until `tools[id]` is true. */
  tools?: Partial<Record<ToolId, boolean>>;
  /** Runtime tool declarations (e.g. load_when_needed strategy) */
  dynamicTools?: DynamicToolDeclaration[];
  /** Generic host-owned loader for T2 dynamic tool schema expansion. */
  dynamicToolLoader?: DynamicToolLoader;
  /** Host-owned metadata preserved for traces; the kernel does not interpret it. */
  metadata?: Record<string, unknown>;
  input?: TurnInput;
  toolInvoke?: { name: CustomToolId; arguments: Record<string, unknown> };
}

/** Safe profile projection suitable for UI or host inspection. */
export interface ProjectedProfile {
  id: string;
  handle: string;
  chat: boolean;
  maxSteps: number;
  models: ModelId[];
  select: Record<string, ModelId> | null;
  controls: ControlId[];
  tools: Array<ToolCatalogEntry & { name: ToolId }>;
  inputs: Profile['inputs'];
  slots: Record<string, string[]>;
  outputs: Profile['outputs'];
  image?: ImageModelSpec | null;
}

/** Fully-resolved provider request state created from a `TurnRequest`. */
export interface ResolvedGeneration {
  model: ModelId;
  previousInteractionId?: string;
  store?: boolean;
  thinking: ThinkingLevel;
  summaries: 'auto' | 'none';
  maxOutputTokens: number;
  temperature: number;
  builtins: BuiltinToolId[];
  custom: CustomToolId[];
  dynamicTools?: DynamicToolDeclaration[];
  dynamicToolLoader?: DynamicToolLoader;
  sessionPermissions?: string[];
  history?: TurnHistoryMessage[];
  maxSteps: number;
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  voice?: ProfileVoiceSpec;
  input: InteractionPart[];
  geminiBucket: GeminiBucket;
  canary: string;
}

/** Tool execution status returned to the model and stream. */
export type ToolStatus = 'ok' | 'error' | 'pause';

/** Structured result envelope returned by deterministic tool handlers. */
export interface ToolEnvelope {
  status: ToolStatus;
  finding?: string;
  data?: Record<string, unknown>;
}

/** Token accounting emitted by providers or fallback estimation. */
export interface TurnTokens {
  input: number;
  output: number;
  thinking?: number;
  toolUse?: number;
  total: number;
}

/** Normalized citation or place source surfaced from a provider. */
export interface GroundingSource {
  title: string;
  uri: string;
  type: 'maps' | 'web';
}

/** Google grounding metadata normalized into a stream event. */
export interface GroundingEvent {
  metadata?: Record<string, unknown>;
  chunks?: unknown[];
  searchHtml?: string;
  sources: GroundingSource[];
}

/** Provider evidence such as OpenRouter citations or annotations. */
export interface ProviderEvidenceEvent {
  provider: 'openrouter' | 'google' | string;
  raw?: Record<string, unknown>;
  citations?: string[];
  annotations?: unknown[];
  sources?: GroundingSource[];
}

/** Public event yielded by providers and by `runTurn`. */
export interface TurnEvent {
  type: TurnEventType;
  text?: string;
  tool?: {
    name: string;
    arguments?: Record<string, unknown>;
    result?: ToolEnvelope;
    id?: string;
  };
  structured?: unknown;
  media?: { mimeType: string; data: string };
  grounding?: GroundingEvent;
  evidence?: ProviderEvidenceEvent;
  tokens?: TurnTokens;
  interactionId?: string;
  error?: string;
}

/** Provider-neutral request object sent from the kernel to a model adapter. */
export interface ProviderCompleteRequest {
  model: ModelId;
  previousInteractionId?: string;
  store?: boolean;
  thinking: ThinkingLevel;
  summaries: 'auto' | 'none';
  maxOutputTokens: number;
  temperature: number;
  builtins: BuiltinToolId[];
  system: string;
  input: InteractionPart[];
  history?: TurnHistoryMessage[];
  dynamicTools?: DynamicToolDeclaration[];
  dynamicToolLoader?: DynamicToolLoader;
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  voice?: ProfileVoiceSpec;
  geminiBucket: GeminiBucket;
  /** Scrubbed SSE / HTTP rows for traces. */
  tapGemini?: (row: Record<string, unknown>) => void;
}

/** Minimal adapter contract every model provider must implement. */
export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<TurnEvent>;
}
