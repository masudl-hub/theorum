import { publicError, TheorumError } from '../guardrails/error.ts';
import { tryStructured } from '../kernel/engine/delta.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnTokens,
} from '../kernel/types.ts';
import {
  type OpenRouterConfig,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from './openrouter-payload.ts';
import { takeSsePayloads } from './sse.ts';

const HTTP_OK = 200;
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterToolDelta {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

interface StreamAccumulator {
  text: string;
  toolCalls: Map<number, OpenRouterToolDelta>;
}

async function* readSseLines(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) {
    throw new TheorumError('empty OpenRouter stream');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const taken = takeSsePayloads(buffer, pendingEvent);
    buffer = taken.rest;
    pendingEvent = taken.pendingEvent;
    for (const payload of taken.payloads) {
      yield payload;
    }
  }
}

function extractReasoning(delta: Record<string, unknown>): string | undefined {
  if (typeof delta.reasoning === 'string') {
    return delta.reasoning;
  }
  if (typeof delta.thinking === 'string') {
    return delta.thinking;
  }
  return undefined;
}

function applyToolCallObject(
  callObj: Record<string, unknown>,
  toolMap: Map<number, OpenRouterToolDelta>,
): void {
  let index = 0;
  if (typeof callObj.index === 'number') {
    index = callObj.index;
  }
  const current = toolMap.get(index) ?? { index, arguments: '' };
  if (typeof callObj.id === 'string') {
    current.id = callObj.id;
  }
  const fn = callObj.function as Record<string, unknown> | undefined;
  if (fn) {
    if (typeof fn.name === 'string') {
      current.name = (current.name ?? '') + fn.name;
    }
    if (typeof fn.arguments === 'string') {
      current.arguments += fn.arguments;
    }
  }
  toolMap.set(index, current);
}

function processToolCalls(rawCalls: unknown[], toolMap: Map<number, OpenRouterToolDelta>): void {
  for (const rawCall of rawCalls) {
    if (rawCall && typeof rawCall === 'object') {
      applyToolCallObject(rawCall as Record<string, unknown>, toolMap);
    }
  }
}

function processDelta(delta: Record<string, unknown>, acc: StreamAccumulator): TurnEvent[] {
  const events: TurnEvent[] = [];

  const reasoning = extractReasoning(delta);
  if (reasoning) {
    events.push({ type: 'thought', text: reasoning });
  }

  if (typeof delta.content === 'string') {
    acc.text += delta.content;
    events.push({ type: 'text', text: delta.content });
  }

  if (Array.isArray(delta.tool_calls)) {
    processToolCalls(delta.tool_calls, acc.toolCalls);
  }

  return events;
}

function parseUsage(usageRaw: unknown): TurnTokens | undefined {
  if (!usageRaw || typeof usageRaw !== 'object') {
    return undefined;
  }
  const u = usageRaw as Record<string, unknown>;
  let input = 0;
  if (typeof u.prompt_tokens === 'number') {
    input = u.prompt_tokens;
  }
  let output = 0;
  if (typeof u.completion_tokens === 'number') {
    output = u.completion_tokens;
  }
  let total = input + output;
  if (typeof u.total_tokens === 'number') {
    total = u.total_tokens;
  }
  return { input, output, total };
}

function parseToolArgs(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs);
  } catch {
    return { _raw: rawArgs };
  }
}

function emitRemainingTools(acc: StreamAccumulator): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const tool of acc.toolCalls.values()) {
    if (tool.name) {
      let args: Record<string, unknown> | undefined;
      if (tool.arguments) {
        args = parseToolArgs(tool.arguments);
      }
      events.push({
        type: 'tool',
        tool: {
          name: tool.name,
          arguments: args,
          ...(tool.id ? { id: tool.id } : {}),
        },
      });
    }
  }
  return events;
}

function buildHeaders(apiKey: string, config: OpenRouterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }
  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }
  return headers;
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
): AsyncGenerator<TurnEvent> {
  const apiKey =
    config.apiKey ?? (typeof Deno !== 'undefined' ? Deno.env.get('OPENROUTER_API_KEY') : undefined);
  if (!apiKey) {
    yield { type: 'error', error: publicError('missing OpenRouter API key') };
    return;
  }

  const baseUrl = config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const fetchFn = config.fetch ?? fetch;

  const headers = buildHeaders(apiKey, config);
  const body = JSON.stringify(toOpenRouterPayload(req, config));
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body,
  });

  if (res.status !== HTTP_OK) {
    yield { type: 'error', error: publicError(`OpenRouter HTTP ${String(res.status)}`) };
    return;
  }

  const acc: StreamAccumulator = { text: '', toolCalls: new Map() };
  let emittedTokens = false;

  for await (const payload of readSseLines(res)) {
    req.tapGemini?.(payload);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (choice && typeof choice === 'object') {
        const c = choice as Record<string, unknown>;
        if (c.delta && typeof c.delta === 'object') {
          const events = processDelta(c.delta as Record<string, unknown>, acc);
          for (const ev of events) {
            yield ev;
          }
        }
      }
    }

    const usage = parseUsage(payload.usage);
    if (usage && !emittedTokens) {
      emittedTokens = true;
      yield { type: 'tokens', tokens: usage };
    }
  }

  const toolEvents = emitRemainingTools(acc);
  for (const ev of toolEvents) {
    yield ev;
  }

  if (req.structured && acc.text) {
    const structured = tryStructured(acc.text);
    if (structured) {
      yield structured;
    }
  }

  yield { type: 'done' };
}

function createOpenRouterProvider(config: OpenRouterConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamOpenRouter(req, config),
  };
}

export type { OpenRouterConfig };
export { createOpenRouterProvider, resolveOpenRouterModel, toOpenRouterPayload };
