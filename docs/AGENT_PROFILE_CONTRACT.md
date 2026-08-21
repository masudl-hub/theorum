# Theorum Profile Specification

A **Profile** is the deterministic, typed security and behavioral contract for an agent role in Theorum.

Every profile strictly namespaces its capabilities across 6 functional domains:
1. `identity` — Persona, display handle, and static base system prompts.
2. `model` — Protocol, provider backend, model whitelist, thinking level, and controls.
3. `tools` — Tool access ceiling.
4. `inputs` — Strict ingress constraints, file limits, and routing slots.
5. `outputs` — Egress contracts, structured schemas, voice, media, and validation/auto-repair.
6. `guardrails` — Rate limits, canary leak detection, and content safety policies.

---

## 1. Type Definition

```typescript
export interface Profile {
  /** Unique profile identifier (e.g. 'orchestrator', 'deep_think', 'speak') */
  id: ProfileId;

  /** 1. Identity & Persona */
  identity: {
    handle: string;
    chat?: boolean;
    system?: string;
    systemByRole?: Record<string, string>;
  };

  /** 2. Model & Execution Bounds */
  model: {
    protocol: 'interactions' | 'openrouter';
    provider: 'google' | 'openrouter';
    allow: ModelId[];
    select?: Record<string, ModelId>;
    thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
    controls?: ControlId[];
    maxSteps?: number;
    key?: GeminiFreeBucket;
  };

  /** 3. Tools Envelope */
  tools: {
    allow: ToolId[];
  };

  /** 4. Ingress (Input constraints & slots) */
  inputs: {
    text?: boolean;
    attachments?: { accept: string[] };
    voice?: { accept: string[] };
    maxFiles?: number;
    maxBytes?: number;
    maxTurnBytes?: number;
    slots?: Record<string, string[]>;
  };

  /** 5. Egress (Structured output, voice, media, validation, streaming) */
  outputs: {
    structured?: StructuredSchemaId | StructuredBySlot | null;
    media?: boolean;
    voice?: ProfileVoiceSpec;
    validation?: ProfileValidationSpec;
    streaming?: ProfileStreamingSpec;
    commit?: 'artifact' | 'state' | string;
  };

  /** 6. Guardrails (Policies & safety boundaries) */
  guardrails: {
    quota: { perDay: number };
    canary?: boolean;
    sanitizeInput?: boolean;
    redactSensitive?: boolean;
  };
}
```

---

## 2. Field Reference

### `identity`
- `identity.handle`: Public-facing display handle for the persona.
- `identity.chat`: Flag marking whether this profile participates in interactive chat.
- `identity.system`: Base system prompt block. Fenced and bound by Theorum guardrails.
- `identity.systemByRole`: Role-specialized system prompts (e.g., `{ critic: '...', planner: '...' }`).

### `model`
- `model.protocol`: Wire framing protocol (`'interactions'` for Google Interactions API, `'openrouter'` for OpenRouter OpenAI-compatible API).
- `model.provider`: Provider execution backend (`'google'` or `'openrouter'`).
- `model.allow`: Whitelist of allowable `ModelId`s for this profile.
- `model.select`: Named model mappings (e.g. `{ fast: 'gemini35FlashLite', smart: 'gemini37Flash' }`).
- `model.thinking`: Pinned thinking level (`'minimal' | 'low' | 'medium' | 'high'`) when not user-controllable.
- `model.controls`: User-togglable controls on this profile (e.g. `['thinking']`).
- `model.maxSteps`: Step limit on autonomous tool loops (1 = one-shot; >1 = autonomous tool loop).
- `model.key`: Gemini free bucket quota pool (`'studio' | 'portfolio' | 'planner'`).

### `tools`
- `tools.allow`: Whitelist of tool IDs permitted to run under this profile. Calls to unlisted tools are blocked at the kernel boundary.

### `inputs`
- `inputs.text`: Boolean flag accepting user text input.
- `inputs.attachments`: Allowed mime types for uploaded file attachments.
- `inputs.voice`: Allowed mime types for recorded audio clips.
- `inputs.maxFiles`: Maximum number of files permitted per message.
- `inputs.maxBytes`: Maximum byte size permitted per single file.
- `inputs.maxTurnBytes`: Maximum total byte size permitted across all files in one turn.
- `inputs.slots`: Allowed values for dynamic routing slots.

### `outputs`
- `outputs.structured`: Structured JSON schema specification (or slot-based schema routing).
- `outputs.media`: Flag enabling native image generation output.
- `outputs.voice`: Voice specification for TTS (`voice.voice`, `voice.responseFormat: 'pcm' | 'mp3'`).
- `outputs.validation`: In-harness auto-correction validator (`extract`, `validate`, `maxRetries`, `repairGuidance`).
- `outputs.streaming`: SSE streaming behaviors (`streamThoughts`, `gateArtifacts`).
- `outputs.commit`: Commit strategy (`'artifact'`, `'state'`).

### `guardrails`
- `guardrails.quota.perDay`: Daily turn quota enforced per client IP.
- `guardrails.canary`: Enable unique token canary leak interception (default `true`).
- `guardrails.sanitizeInput`: Run prompt injection / jailbreak redaction on ingress text (default `true`).
- `guardrails.redactSensitive`: Redact SSN, credit cards, IP addresses, API keys from inputs (default `true`).
