import { TheorumError } from '../guardrails/error.ts';
import { CATALOG } from '../kernel/registry/catalog.ts';
import { getStructured } from '../kernel/registry/schemas.ts';
import type { BuiltinToolId, InteractionPart, ProviderCompleteRequest } from '../kernel/types.ts';

const BUILTIN_API: Record<BuiltinToolId, string> = {
  googleSearch: 'google_search',
  googleMaps: 'google_maps',
  urlContext: 'url_context',
};

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
  if (req.image) {
    camel.responseFormat = {
      type: 'image',
      mimeType: req.image.mimeType,
      aspectRatio: req.image.aspectRatio,
      imageSize: req.image.imageSize,
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

/** Interactions REST body for one complete() call (Google snake_case keys). */
function toInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  if (systemHoldsUserInput(req.system, req.input)) {
    throw new TheorumError('user input cannot be placed in the system block');
  }
  const catalog = CATALOG.models[req.model];
  const camel: Record<string, unknown> = {
    model: catalog.apiId,
    stream: true,
    input: [userInputStep(req.input)],
    generationConfig: {
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      thinkingLevel: req.thinking,
      thinkingSummaries: req.summaries,
    },
    store: false,
  };
  if (req.system) {
    camel.systemInstruction = req.system;
  }
  if (req.builtins.length > 0) {
    camel.tools = req.builtins.map((id) => ({ type: BUILTIN_API[id] }));
  }
  attachResponseFormat(req, camel);
  return toGoogleValue(camel) as Record<string, unknown>;
}

export { camelToSnake, toInteractionsBody };
