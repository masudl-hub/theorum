/** Gemini thinking_level — not every model accepts every value.
 * 3.1/3.5 Flash Lite: minimal|low|medium|high
 * 3.7 Flash: low|medium|high (no minimal)
 * 3.1 Flash Lite Image: minimal|high
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type StandardModelId =
  | 'gemini31FlashLite'
  | 'gemini35FlashLite'
  | 'gemini37Flash'
  | 'gemini31FlashLiteImage'
  | 'gemini31FlashTts';

export type ModelId = StandardModelId | (string & {});

export type ToolId =
  | 'googleSearch'
  | 'googleMaps'
  | 'urlContext'
  | 'askUser'
  | 'generateMedia'
  | 'writeArtifact'
  | 'validate'
  | 'analyze'
  | 'commit'
  | 'handoff';

export type BuiltinToolId = 'googleSearch' | 'googleMaps' | 'urlContext';
export type CustomToolId = Exclude<ToolId, BuiltinToolId>;

export type StructuredSchemaId = string;

/** Interactions inline part types Gemini accepts besides text. */
export type GeminiInputKind = 'image' | 'audio' | 'video' | 'document';

export type ProfileId = string;

export type GeminiBucket = 'studio' | 'portfolio' | 'planner' | 'paid';
export type GeminiFreeBucket = Exclude<GeminiBucket, 'paid'>;

export type ChatRole = 'system' | 'user' | 'assistant';
export type ControlId = 'thinking';

export type ImageSize = '1K';

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

export type TurnEventType =
  | 'thought'
  | 'text'
  | 'tool'
  | 'structured'
  | 'media'
  | 'commit'
  | 'tokens'
  | 'done'
  | 'error';

export interface ThinkingMap {
  on: ThinkingLevel;
  off: ThinkingLevel;
}

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

export interface ModelCatalogEntry {
  apiId: string;
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

export interface ToolCatalogEntry {
  kind: 'builtin' | 'custom';
  ui: boolean;
  schema?: Record<string, unknown>;
}

export interface StructuredSpec {
  enforced: 'responseFormat' | 'prompt';
  jsonSchema?: Record<string, unknown>;
}

export interface Catalog {
  models: Record<ModelId, ModelCatalogEntry>;
  tools: Record<ToolId, ToolCatalogEntry>;
}

export interface MediaLimits {
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
}

export interface MimeInputs extends Partial<MediaLimits> {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
}

export interface StructuredBySlot {
  by: string;
  map: Record<string, string>;
  fallback: string;
}

export interface ProfileModels {
  allow: ModelId[];
  select?: Record<string, ModelId>;
  /** Pinned level when `thinking` is not in `controls`. */
  thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
  override?: Partial<
    Record<
      ModelId,
      Partial<
        Pick<ModelCatalogEntry, 'maxOutputTokens' | 'temperature'> & { summaries?: 'auto' | 'none' }
      >
    >
  >;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  finding?: string;
  data?: Record<string, unknown>;
}

export type ProfileValidator = (
  artifact: unknown,
  slots?: Record<string, string>,
) => ValidationResult | Promise<ValidationResult>;

export interface ProfileValidationSpec {
  extract: (structured: unknown) => unknown;
  validate: ProfileValidator;
  maxRetries?: number;
  repairGuidance?: string;
}

export type OpenRouterAudioFormat = 'pcm' | 'mp3';

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

export interface ProfileVoiceSpec {
  voice?: OpenRouterTtsVoice;
  responseFormat?: OpenRouterAudioFormat;
}

export interface ProfileStreamingSpec {
  mode: 'sse' | 'buffered';
  streamThoughts?: boolean;
  gateArtifacts?: boolean;
}

export interface ProfileGuardrailsSpec {
  quota: { perDay: number };
  canary?: boolean;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
}

export interface ProfileModelSpec {
  protocol: 'interactions' | 'openrouter';
  provider: 'google' | 'openrouter';
  allow: ModelId[];
  select?: Record<string, ModelId>;
  thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
  controls?: ControlId[];
  maxSteps?: number;
  key?: GeminiFreeBucket;
  override?: Record<
    string,
    { maxOutputTokens?: number; temperature?: number; summaries?: 'auto' | 'none' }
  >;
}

export interface ProfileInputsSpec {
  text?: boolean;
  attachments?: { accept: string[] };
  voice?: { accept: string[] };
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  slots?: Record<string, string[]>;
}

export interface ProfileOutputsSpec {
  structured?: StructuredSchemaId | StructuredBySlot | null;
  media?: boolean;
  voice?: ProfileVoiceSpec;
  validation?: ProfileValidationSpec;
  streaming?: ProfileStreamingSpec;
  commit?: 'artifact' | 'state' | string;
}

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

export interface InteractionTextPart {
  type: 'text';
  text: string;
}

export interface InteractionMediaPart {
  type: GeminiInputKind;
  mimeType: string;
  data: string;
}

export type InteractionPart = InteractionTextPart | InteractionMediaPart;

export interface ImageResponseFormat {
  type: 'image';
  mimeType: string;
  aspectRatio: ImageAspectRatio;
  imageSize: ImageSize;
}

export interface TurnBlob {
  mimeType: string;
  data: string;
}

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

export interface DynamicToolDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => ToolEnvelope | Promise<ToolEnvelope>;
}

export interface TurnFixRequest {
  artifact: string;
  error: string;
  guidance?: string;
}

export interface TurnRequest {
  profile: ProfileId;
  /** Caller project id when one exists. Omitted on some HTTP hosts. */
  projectId?: string;
  select?: string;
  thinking?: boolean;
  /** Host-provided dynamic system prompt combined with profile persona */
  system?: string;
  /** Opt-in gates. Profile `allow` is the ceiling; a tool is off until `tools[id]` is true. */
  tools?: Partial<Record<ToolId, boolean>>;
  /** Runtime tool declarations (e.g. load_when_needed strategy) */
  dynamicTools?: DynamicToolDeclaration[];
  input: {
    text?: string;
    role?: string;
    slots?: Record<string, string>;
    attachments?: TurnBlob[];
    voice?: TurnBlob[];
    history?: TurnHistoryMessage[];
    fix?: TurnFixRequest;
  };
  toolInvoke?: { name: CustomToolId; arguments: Record<string, unknown> };
}

export interface ResolvedGeneration {
  model: ModelId;
  thinking: ThinkingLevel;
  summaries: 'auto' | 'none';
  maxOutputTokens: number;
  temperature: number;
  builtins: BuiltinToolId[];
  custom: CustomToolId[];
  dynamicTools?: DynamicToolDeclaration[];
  history?: TurnHistoryMessage[];
  maxSteps: number;
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  voice?: ProfileVoiceSpec;
  input: InteractionPart[];
  geminiBucket: GeminiBucket;
  canary: string;
}

export type ToolStatus = 'ok' | 'error' | 'pause';

export interface ToolEnvelope {
  status: ToolStatus;
  finding: string;
  data?: Record<string, unknown>;
}

export interface TurnTokens {
  input: number;
  output: number;
  thinking?: number;
  toolUse?: number;
  total: number;
}

export interface TurnEvent {
  type: TurnEventType;
  text?: string;
  tool?: { name: string; arguments?: Record<string, unknown>; result?: ToolEnvelope; id?: string };
  structured?: unknown;
  media?: { mimeType: string; data: string };
  tokens?: TurnTokens;
  interactionId?: string;
  error?: string;
}

export interface ProviderCompleteRequest {
  model: ModelId;
  thinking: ThinkingLevel;
  summaries: 'auto' | 'none';
  maxOutputTokens: number;
  temperature: number;
  builtins: BuiltinToolId[];
  system: string;
  input: InteractionPart[];
  history?: TurnHistoryMessage[];
  dynamicTools?: DynamicToolDeclaration[];
  structured: StructuredSchemaId | null;
  image: ImageResponseFormat | null;
  voice?: ProfileVoiceSpec;
  geminiBucket: GeminiBucket;
  /** Scrubbed SSE / HTTP rows for traces. */
  tapGemini?: (row: Record<string, unknown>) => void;
}

export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<TurnEvent>;
}
