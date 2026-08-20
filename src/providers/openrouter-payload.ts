import { CATALOG } from '../kernel/registry/catalog.ts';
import { getStructured } from '../kernel/registry/schemas.ts';
import type {
  DynamicToolDeclaration,
  InteractionMediaPart,
  InteractionPart,
  ModelId,
  ProviderCompleteRequest,
  ThinkingLevel,
  TurnHistoryMessage,
} from '../kernel/types.ts';

interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
  modelMap?: Record<string, string>;
}

function resolveOpenRouterModel(
  modelId: ModelId | string,
  customMap?: Record<string, string>,
): string {
  if (customMap?.[modelId]) {
    return customMap[modelId];
  }
  const catalogEntry = CATALOG.models[modelId as keyof typeof CATALOG.models];
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

function wireHistoryMessage(msg: TurnHistoryMessage): Record<string, unknown> {
  let content: unknown = msg.content ?? '';
  if (msg.parts && msg.parts.length > 0) {
    content = wireMessageContent(msg.parts);
  }
  return {
    role: msg.role,
    content,
  };
}

function wireTools(dynamicTools?: DynamicToolDeclaration[]): Record<string, unknown>[] {
  if (!dynamicTools || dynamicTools.length === 0) {
    return [];
  }
  return dynamicTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
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

  if (req.history && req.history.length > 0) {
    for (const h of req.history) {
      messages.push(wireHistoryMessage(h));
    }
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

  const tools = wireTools(req.dynamicTools);
  if (tools.length > 0) {
    payload.tools = tools;
  }

  if (req.builtins.includes('googleSearch')) {
    payload.plugins = [{ id: 'web' }];
  }

  return payload;
}

export type { OpenRouterConfig };
export { resolveOpenRouterModel, toOpenRouterPayload };
