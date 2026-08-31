/**
 * Local provider adapter for OpenAI-compatible endpoints (Ollama, llama.cpp,
 * vLLM, LM Studio, etc.).
 *
 * Streams SSE from `/v1/chat/completions`, accumulates tool calls, and yields
 * normalized `TurnEvent` objects. No external SDK dependency — raw fetch + SSE.
 *
 * Hosts pass `baseUrl` explicitly. THEORUM does not read `OLLAMA_HOST` or other
 * environment variables (see docs/SECRETS.md).
 *
 * @module
 */

import { isAbortError, toErrorEvent } from '../guardrails/error.ts';
import { turnStopFromOpenRouter } from '../kernel/stop.ts';
import type {
  DynamicToolDeclaration,
  InteractionPart,
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
} from '../kernel/types.ts';
import { exposeForTests } from './expose-for-tests.ts';

/** Default OpenAI-compat base when the host omits `baseUrl` (Ollama's default port). */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434';

/** Host-supplied config for the local provider. */
export interface LocalProviderConfig {
  /**
   * Base URL of the OpenAI-compat server (no trailing slash).
   * Defaults to `http://127.0.0.1:11434`. Hosts that honor `OLLAMA_HOST` should
   * resolve it themselves and pass the result here.
   */
  baseUrl?: string;
  /** Custom fetch implementation for testing or proxying. */
  fetch?: typeof globalThis.fetch;
}

// ── wire types ──────────────────────────────────────

interface OpenAiDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAiChoice {
  index: number;
  delta?: OpenAiDelta;
  finish_reason?: string | null;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChunk {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
}

type WireContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

type WireMessage = {
  role: string;
  content?: WireContent;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type PendingToolCall = { id: string; name: string; args: string };

// ── request mapping ─────────────────────────────────

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end -= 1;
  return baseUrl.slice(0, end);
}

function resolveBaseUrl(config?: LocalProviderConfig): string {
  return normalizeBaseUrl(config?.baseUrl?.trim() || DEFAULT_LOCAL_BASE_URL);
}

function inputToContent(parts: InteractionPart[]): WireContent {
  if (parts.every((p) => p.type === 'text')) {
    return parts.map((p) => ('text' in p ? p.text : '')).join('\n');
  }
  return parts.map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${p.mimeType};base64,${p.data}` },
    };
  });
}

function historyMessageContent(msg: TurnHistoryMessage): WireContent | undefined {
  if (msg.parts && msg.parts.length > 0) {
    return inputToContent(msg.parts);
  }
  if (msg.content != null) return msg.content;
  return undefined;
}

function historyToWire(req: ProviderCompleteRequest): WireMessage[] {
  const msgs: WireMessage[] = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  for (const msg of req.history ?? []) {
    msgs.push(historyMessageToWire(msg));
  }
  if (req.input.length > 0) {
    msgs.push({ role: 'user', content: inputToContent(req.input) });
  }
  return msgs;
}

function historyMessageToWire(msg: TurnHistoryMessage): WireMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: msg.tool_call_id ?? `call_${msg.name ?? 'tool'}`,
      name: msg.name,
      content: msg.content ?? '',
    };
  }
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: historyMessageContent(msg) ?? undefined,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  return { role: msg.role, content: historyMessageContent(msg) ?? '' };
}

function toolsToWire(dynamicTools?: DynamicToolDeclaration[]):
  | Array<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>
  | undefined {
  if (!dynamicTools || dynamicTools.length === 0) return undefined;
  return dynamicTools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.apiId,
    messages: historyToWire(req),
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };
  const tools = toolsToWire(req.dynamicTools);
  if (tools) body.tools = tools;
  return body;
}

// ── SSE parsing ─────────────────────────────────────

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as OpenAiChunk;
      } catch {
        // skip malformed
      }
    }
  }
}

// ── stream → TurnEvent ──────────────────────────────

function flushPending(pending: Map<number, PendingToolCall>): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const [, tc] of pending) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(tc.args) as Record<string, unknown>;
    } catch {
      // empty
    }
    events.push({
      type: 'tool',
      tool: { name: tc.name, arguments: parsed, id: tc.id },
    });
  }
  pending.clear();
  return events;
}

async function* streamComplete(
  baseUrl: string,
  req: ProviderCompleteRequest,
  fetchFn: typeof globalThis.fetch,
): AsyncGenerator<TurnEvent> {
  const res = await fetchFn(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(req)),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    yield toErrorEvent(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    return;
  }
  if (!res.body) {
    yield toErrorEvent('empty response body');
    return;
  }
  yield* streamOpenAiBody(res.body);
}

async function* streamOpenAiBody(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const pending = new Map<number, PendingToolCall>();
  let finishReason: string | null | undefined;
  for await (const chunk of parseSse(body)) {
    const usageEvent = tokensFromUsage(chunk.usage);
    if (usageEvent) yield usageEvent;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    yield* eventsFromChoiceDelta(choice.delta, pending);
    if (choice.finish_reason != null) {
      finishReason = choice.finish_reason;
      for (const event of flushPending(pending)) yield event;
    }
  }
  for (const event of flushPending(pending)) yield event;
  yield { type: 'done', stop: turnStopFromOpenRouter(finishReason) };
}

function tokensFromUsage(usage: OpenAiUsage | undefined): TurnEvent | undefined {
  if (!usage) return undefined;
  return {
    type: 'tokens',
    tokens: {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      total: usage.total_tokens ?? 0,
    },
  };
}

function* eventsFromChoiceDelta(
  delta: OpenAiDelta | undefined,
  pending: Map<number, PendingToolCall>,
): Generator<TurnEvent> {
  if (!delta) return;
  if (delta.content) yield { type: 'text', text: delta.content };
  accumulateToolCalls(delta.tool_calls, pending);
}

function accumulateToolCalls(
  toolCalls: OpenAiDelta['tool_calls'],
  pending: Map<number, PendingToolCall>,
): void {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const existing = pending.get(tc.index);
    if (existing) {
      existing.args += tc.function?.arguments ?? '';
      continue;
    }
    pending.set(tc.index, {
      id: tc.id ?? `call_${tc.index}`,
      name: tc.function?.name ?? '',
      args: tc.function?.arguments ?? '',
    });
  }
}

// ── public factory ──────────────────────────────────

/** Create a `ModelProvider` for a local OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio). */
function createLocalProvider(config?: LocalProviderConfig): ModelProvider {
  const baseUrl = resolveBaseUrl(config);
  const fetchFn = config?.fetch ?? globalThis.fetch;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      try {
        yield* streamComplete(baseUrl, req, fetchFn);
      } catch (err) {
        if (isAbortError(err)) throw err;
        yield toErrorEvent(err);
      }
    },
  };
}

export { createLocalProvider };

exposeForTests('local', {
  inputToContent,
  historyMessageContent,
  historyToWire,
  toolsToWire,
  buildBody,
  parseSse,
  flushPending,
  resolveBaseUrl,
  DEFAULT_LOCAL_BASE_URL,
});
