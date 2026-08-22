/** Gemini thinking_level — not every model accepts every value. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type StandardModelId =
  | 'gemini31FlashLite'
  | 'gemini31ProPreview'
  | 'gemini35FlashLite'
  | 'gemini37Flash'
  | 'gemini31FlashLiteImage'
  | 'gemini31FlashTts'
  | 'sonar';

export type ModelId = StandardModelId | (string & Record<PropertyKey, never>);

export type BuiltinToolId = 'googleSearch' | 'googleMaps' | 'urlContext';
export type StandardCustomToolId =
  | 'askUser'
  | 'generateMedia'
  | 'writeArtifact'
  | 'validate'
  | 'analyze'
  | 'commit'
  | 'handoff';
export type CustomToolId = StandardCustomToolId | (string & Record<PropertyKey, never>);
export type ToolId = BuiltinToolId | CustomToolId;

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
  | 'grounding'
  | 'evidence'
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
  limitsByMime?: Record<string, number>;
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
        Pick<ModelCatalogEntry, 'maxOutputTokens' | 'temperature'> & {
          summaries?: 'auto' | 'none';
        }
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
  | (string & Record<PropertyKey, never>);

export interface ProfileVoiceSpec {
  voice?: OpenRouterTtsVoice;
  responseFormat?: OpenRouterAudioFormat;
}

export interface ProfileStreamingSpec {
  mode: 'sse' | 'buffered';
  streamThoughts?: boolean;
  gateArtifacts?: boolean;
}

export interface EgressContext {
  text: string;
  canary?: string;
  slots?: Record<string, string>;
  profile: Profile;
  role?: string;
}

export interface EgressEnforcementResult {
  blocked: boolean;
  text: string;
  hits?: string[];
  rejectionMessage?: string | null;
}

export type EgressEnforcer = (
  context: EgressContext,
) => EgressEnforcementResult | Promise<EgressEnforcementResult>;

export interface ProfileEgressSpec {
  enforce: EgressEnforcer;
  onBlock?: 'reject_to_agent' | 'refuse_to_user';
  maxRetries?: number;
  repairGuidance?: string;
}

export interface ProfileGuardrailsSpec {
  quota: { perDay: number };
  canary?: boolean;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
  egress?: ProfileEgressSpec;
}

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

export type ToolLoadTier = 'T0' | 'T1' | 'T2';
export type ToolPermissionTier = 'auto' | 'session_consent' | 'always_confirm';

export interface DynamicToolExecutionContext {
  args: Record<string, unknown>;
  profile: Profile;
  sessionPermissions?: string[];
}

export interface DynamicToolLoadContext {
  name: string;
  args: Record<string, unknown>;
  profile: Profile;
  currentTools: DynamicToolDeclaration[];
  sessionPermissions?: string[];
}

export type DynamicToolLoader = (
  context: DynamicToolLoadContext,
) => DynamicToolDeclaration[] | Promise<DynamicToolDeclaration[]>;

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

export interface TurnFixRequest {
  artifact: string;
  error: string;
  guidance?: string;
}

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

export interface GroundingSource {
  title: string;
  uri: string;
  type: 'maps' | 'web';
}

export interface GroundingEvent {
  metadata?: Record<string, unknown>;
  chunks?: unknown[];
  searchHtml?: string;
  sources: GroundingSource[];
}

export interface ProviderEvidenceEvent {
  provider: 'openrouter' | 'google' | string;
  raw?: Record<string, unknown>;
  citations?: string[];
  annotations?: unknown[];
  sources?: GroundingSource[];
}

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

export interface ModelProvider {
  complete: (req: ProviderCompleteRequest) => AsyncIterable<TurnEvent>;
}
