import { CATALOG } from '../kernel/registry/catalog.ts';
import { getStructured } from '../kernel/registry/schemas.ts';
import type {
  InteractionMediaPart,
  InteractionPart,
  ModelId,
  ProviderCompleteRequest,
  ThinkingLevel,
} from '../kernel/types.ts';

interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
  modelMap?: Record<string, string>;
}

const DEFAULT_MODEL_MAP: Record<string, string> = {
  gemini35FlashLite: 'google/gemini-2.5-flash',
  gemini31FlashLite: 'google/gemini-2.5-flash',
  gemini37Flash: 'google/gemini-2.5-pro',
  gemini31ProPreview: 'google/gemini-2.5-pro',
};

function resolveOpenRouterModel(
  modelId: ModelId | string,
  customMap?: Record<string, string>,
): string {
  if (customMap?.[modelId]) {
    return customMap[modelId];
  }
  if (DEFAULT_MODEL_MAP[modelId]) {
    return DEFAULT_MODEL_MAP[modelId];
  }
  const catalogEntry = CATALOG.models[modelId as ModelId];
  if (catalogEntry?.apiId) {
    return `google/${catalogEntry.apiId}`;
  }
  return String(modelId);
}

function mapThinkingEffort(thinking: ThinkingLevel): 'low' | 'medium' | 'high' | null {
  if (thinking === 'low') {
    return 'low';
  }
  if (thinking === 'medium') {
    return 'medium';
  }
  if (thinking === 'high') {
    return 'high';
  }
  return null;
}

function wireAudioPart(part: InteractionMediaPart): Record<string, unknown> {
  let format = 'mp3';
  if (part.mimeType.includes('wav')) {
    format = 'wav';
  }
  return {
    type: 'input_audio',
    input_audio: {
      data: part.data,
      format,
    },
  };
}

function wireMessageContent(parts: InteractionPart[]): unknown {
  const isAllText = parts.every((p) => p.type === 'text');
  if (isAllText) {
    return parts
      .map((p) => {
        if (p.type === 'text') {
          return p.text;
        }
        return '';
      })
      .join('\n');
  }
  return parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      };
    }
    if (part.type === 'audio') {
      return wireAudioPart(part);
    }
    return { type: 'text', text: '' };
  });
}

function toOpenRouterPayload(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
): Record<string, unknown> {
  const model = resolveOpenRouterModel(req.model, config.modelMap);
  const messages: Record<string, unknown>[] = [];

  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  if (req.input.length > 0) {
    messages.push({
      role: 'user',
      content: wireMessageContent(req.input),
    });
  }

  const payload: Record<string, unknown> = {
    model,
    stream: true,
    messages,
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };

  const effort = mapThinkingEffort(req.thinking);
  if (effort) {
    payload.reasoning = { effort };
  }

  if (req.structured) {
    const spec = getStructured(req.structured);
    if (spec.jsonSchema) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: String(req.structured),
          strict: true,
          schema: spec.jsonSchema,
        },
      };
    }
  }

  if (req.builtins.includes('googleSearch')) {
    payload.plugins = [{ id: 'web' }];
  }

  return payload;
}

export type { OpenRouterConfig };
export { resolveOpenRouterModel, toOpenRouterPayload };
