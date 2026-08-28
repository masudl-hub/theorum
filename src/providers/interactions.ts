import { TheorumError } from '../guardrails/error.ts';
import { getTool } from '../kernel/registry/catalog.ts';
import { getStructured } from '../kernel/registry/schemas.ts';
import type { InteractionPart, ProviderCompleteRequest } from '../kernel/types.ts';

function camelToSnake(key: string): string {
  return key.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function toGoogleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toGoogleValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      // JSON Schema property names must stay as authored (e.g. correctAnswer in
      // both properties and required). Snake-casing breaks Gemini validation.
      if (key === 'schema') {
        out[camelToSnake(key)] = nested;
        continue;
      }
      out[camelToSnake(key)] = toGoogleValue(nested);
    }
    return out;
  }
  return value;
}

function wirePart(part: InteractionPart): Record<string, string> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return { type: part.type, mimeType: part.mimeType, data: part.data };
}

const USER_INPUT = 'user_input';

function userInputStep(parts: InteractionPart[]): {
  type: string;
  content: Record<string, string>[];
} {
  return { type: USER_INPUT, content: parts.map(wirePart) };
}

function historyStep(msg: import('../kernel/types.ts').TurnHistoryMessage): {
  type: string;
  content: Record<string, string>[];
} {
  const isAssistant = msg.role === 'assistant';
  // Google Interactions input steps: assistant history is `model_output` (not `model_turn`).
  const type = isAssistant ? 'model_output' : 'user_input';
  if (msg.parts && msg.parts.length > 0) {
    return { type, content: msg.parts.map(wirePart) };
  }
  return { type, content: [{ type: 'text', text: msg.content ?? '' }] };
}

function systemHoldsUserInput(system: string, parts: InteractionPart[]): boolean {
  for (const part of parts) {
    if (part.type === 'text' && part.text && system.includes(part.text)) {
      return true;
    }
  }
  return false;
}

function jsonResponseFormat(schema: Record<string, unknown>): unknown[] {
  return [{ type: 'text', mimeType: 'application/json', schema }];
}

function attachResponseFormat(req: ProviderCompleteRequest, camel: Record<string, unknown>): void {
  if (req.speech) {
    if (req.image) {
      throw new TheorumError('cannot mix speech and image response formats');
    }
    if (req.structured) {
      throw new TheorumError('cannot mix speech and structured response formats');
    }
    camel.responseFormat = { type: 'audio' };
    return;
  }
  if (req.image) {
    camel.responseFormat = {
      type: 'image',
      mimeType: req.image.mimeType,
      aspectRatio: req.image.aspectRatio,
      imageSize: req.image.size,
    };
    return;
  }
  if (!req.structured) {
    return;
  }
  const spec = getStructured(req.structured);
  if (spec.enforced !== 'responseFormat' || !spec.jsonSchema) {
    return;
  }
  camel.responseFormat = jsonResponseFormat(spec.jsonSchema);
}

function attachSpeechConfig(
  req: ProviderCompleteRequest,
  generationConfig: Record<string, unknown>,
): void {
  if (!req.speech) {
    return;
  }
  if (req.speech.voice) {
    generationConfig.speechConfig = [{ voice: req.speech.voice }];
  }
}

function inputStepsFromRequest(req: ProviderCompleteRequest): {
  type: string;
  content: Record<string, string>[];
}[] {
  const inputSteps: { type: string; content: Record<string, string>[] }[] = [];
  for (const h of req.history ?? []) {
    inputSteps.push(historyStep(h));
  }
  if (req.input.length > 0 || inputSteps.length === 0) {
    inputSteps.push(userInputStep(req.input));
  }
  return inputSteps;
}

function applyOptionalRequestFields(
  req: ProviderCompleteRequest,
  camel: Record<string, unknown>,
): void {
  if (req.store !== undefined) {
    camel.store = req.store;
  }
  if (req.previousInteractionId) {
    camel.previousInteractionId = req.previousInteractionId;
  }
  if (req.system) {
    camel.systemInstruction = req.system;
  }
  if (req.builtins.length > 0) {
    camel.tools = req.builtins.map((id) => {
      const type = getTool(id)?.interactionsType;
      if (!type) {
        throw new TheorumError(`Builtin '${id}' has no Interactions wire type`);
      }
      return { type };
    });
  }
}

function baseInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  };
  if (req.speech) {
    // TTS models reject chat thinking knobs; voice lives under speech_config.
    attachSpeechConfig(req, generationConfig);
  } else {
    generationConfig.thinkingLevel = req.thinking;
    generationConfig.thinkingSummaries = req.summaries;
  }
  return {
    model: req.apiId,
    stream: true,
    input: inputStepsFromRequest(req),
    generationConfig,
  };
}

/** Interactions REST body for one complete() call (Google snake_case keys). */
function toInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  if (systemHoldsUserInput(req.system, req.input)) {
    throw new TheorumError('user input cannot be placed in the system block');
  }
  const camel = baseInteractionsBody(req);
  applyOptionalRequestFields(req, camel);
  attachResponseFormat(req, camel);
  return toGoogleValue(camel) as Record<string, unknown>;
}

export { camelToSnake, toInteractionsBody };

/** @internal Exported for direct unit testing only. */
export const _internals = {
  camelToSnake,
  toGoogleValue,
  wirePart,
  userInputStep,
  historyStep,
  systemHoldsUserInput,
  jsonResponseFormat,
  attachResponseFormat,
  attachSpeechConfig,
  inputStepsFromRequest,
  applyOptionalRequestFields,
  baseInteractionsBody,
  toInteractionsBody,
};
