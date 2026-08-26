/**
 * OpenRouter provider adapter powered by Vercel AI SDK Core.
 *
 * THEORUM keeps the public `ModelProvider` and `TurnEvent` contract; AI SDK
 * owns the OpenRouter call, stream parsing, provider compatibility, and tool
 * call normalization.
 *
 * @module
 */

import { createOpenRouter, type OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import {
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from 'ai';
import { isAbortError, toErrorEvent } from '../guardrails/error.ts';
import { tryStructured } from '../kernel/engine/delta.ts';
import { getTool } from '../kernel/registry/catalog.ts';
import type {
  DynamicToolDeclaration,
  InteractionPart,
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnTokens,
} from '../kernel/types.ts';
import {
  type OpenRouterConfig,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from './openrouter-payload.ts';
import { takeSsePayloads } from './sse.ts';

interface StreamAccumulator {
  text: string;
  evidenceSeen: boolean;
  emittedTokens: boolean;
  errored: boolean;
  toolInputs: Map<string, string>;
}

interface OpenRouterStreamContext {
  openrouter: ReturnType<typeof createOpenRouter>;
  modelName: string;
  rawCapture: () => Promise<TurnEvent[]> | undefined;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
type ProviderOptions = Record<string, { [key: string]: JsonValue }>;

function trimApiKey(explicitKey?: string): string | undefined {
  if (explicitKey?.trim()) {
    return explicitKey.trim();
  }
  return undefined;
}

function createAccumulator(): StreamAccumulator {
  return {
    text: '',
    evidenceSeen: false,
    emittedTokens: false,
    errored: false,
    toolInputs: new Map(),
  };
}

function mediaPart(part: InteractionPart): Record<string, unknown> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    return {
      type: 'image',
      image: `data:${part.mimeType};base64,${part.data}`,
    };
  }
  return { type: 'file', mediaType: part.mimeType, data: part.data };
}

function contentFromParts(parts: InteractionPart[]): string | Array<Record<string, unknown>> {
  if (parts.every((part) => part.type === 'text')) {
    return parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return parts.map(mediaPart);
}

function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function stringDefault(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value;
}

function optionalSingle(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : [value];
}

function fallbackToolCallId(name?: string): string {
  return `call_${stringDefault(name, 'tool')}`;
}

function toolResultContent(msg: TurnHistoryMessage): ModelMessage {
  const toolName = stringDefault(msg.name, 'tool');
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: stringDefault(msg.tool_call_id, fallbackToolCallId(msg.name)),
        toolName,
        output: { type: 'text', value: stringDefault(msg.content, '') },
      },
    ],
  } as unknown as ModelMessage;
}

function assistantToolCallContent(msg: TurnHistoryMessage): ModelMessage | null {
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return null;
  }
  return {
    role: 'assistant',
    content: msg.tool_calls.map((call) => ({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseToolInput(call.function.arguments),
    })),
  } as ModelMessage;
}

function historyMessage(msg: TurnHistoryMessage): ModelMessage | null {
  if (msg.role === 'tool') {
    return toolResultContent(msg);
  }
  return assistantToolCallContent(msg) || contentHistoryMessage(msg);
}

function contentFromOptionalParts(
  parts: InteractionPart[] | undefined,
  text: string | undefined,
): string | Array<Record<string, unknown>> {
  if (!parts || parts.length === 0) {
    return stringDefault(text, '');
  }
  return contentFromParts(parts);
}

function contentHistoryMessage(msg: TurnHistoryMessage): ModelMessage {
  const content = contentFromOptionalParts(msg.parts, msg.content);
  return { role: msg.role, content } as ModelMessage;
}

function sourceValue(
  part: Extract<TextStreamPart<ToolSet>, { type: 'source' }>,
  key: string,
): string | undefined {
  const source = part as Record<string, unknown>;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function sourceUrl(part: Extract<TextStreamPart<ToolSet>, { type: 'source' }>): string | undefined {
  return sourceValue(part, 'url');
}

function sourceTitle(
  part: Extract<TextStreamPart<ToolSet>, { type: 'source' }>,
): string | undefined {
  return sourceValue(part, 'title') ?? sourceUrl(part);
}

function sourceList(title: string | undefined, url: string | undefined) {
  if (title === undefined || url === undefined) {
    return undefined;
  }
  return [{ title, uri: url, type: 'web' as const }];
}

function sourceEvent(part: Extract<TextStreamPart<ToolSet>, { type: 'source' }>): TurnEvent {
  const raw = part as Record<string, unknown>;
  const url = sourceUrl(part);
  const title = sourceTitle(part);
  return {
    type: 'evidence',
    evidence: {
      provider: 'openrouter',
      raw,
      citations: optionalSingle(url),
      sources: sourceList(title, url),
    },
  };
}

function buildMessages(req: ProviderCompleteRequest): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const msg of req.history ?? []) {
    const wired = historyMessage(msg);
    if (wired) {
      messages.push(wired);
    }
  }
  if (req.input.length > 0) {
    messages.push({ role: 'user', content: contentFromParts(req.input) } as ModelMessage);
  }
  return messages;
}

function schemaForTool(decl: DynamicToolDeclaration): Record<string, unknown> {
  return decl.parameters ?? { type: 'object', properties: {}, additionalProperties: true };
}

function buildTools(dynamicTools?: DynamicToolDeclaration[]): ToolSet | undefined {
  if (!dynamicTools || dynamicTools.length === 0) {
    return undefined;
  }
  const tools: ToolSet = {};
  for (const decl of dynamicTools) {
    tools[decl.name] = tool({
      description: decl.description ?? '',
      inputSchema: jsonSchema(schemaForTool(decl)),
    });
  }
  return tools;
}

function openRouterPlugins(req: ProviderCompleteRequest): OpenRouterChatSettings['plugins'] {
  const plugins = req.builtins
    .map((id) => getTool(id)?.openRouterPlugin)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }));
  return plugins.length > 0 ? (plugins as OpenRouterChatSettings['plugins']) : undefined;
}

function openRouterSettings(req: ProviderCompleteRequest): OpenRouterChatSettings | undefined {
  const plugins = openRouterPlugins(req);
  if (!plugins) {
    return undefined;
  }
  return { plugins };
}

function tokensFromUsage(usage: LanguageModelUsage): TurnTokens | undefined {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  if (input === 0 && output === 0 && total === 0) {
    return undefined;
  }
  return {
    input,
    output,
    total,
  };
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

function metadataRecord(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return rawRecord(raw[key]);
}

function citationCandidates(raw: Record<string, unknown>): unknown[] {
  const openrouter = metadataRecord(raw, 'openrouter') ?? {};
  return [
    raw.citations,
    metadataRecord(raw, 'providerMetadata')?.citations,
    metadataRecord(raw, 'provider_metadata')?.citations,
    openrouter.citations,
    metadataRecord(openrouter, 'providerMetadata')?.citations,
    metadataRecord(openrouter, 'provider_metadata')?.citations,
  ];
}

function nestedCitations(raw: Record<string, unknown>): string[] | undefined {
  for (const candidate of citationCandidates(raw)) {
    const citations = stringArray(candidate);
    if (citations) {
      return citations;
    }
  }
  return undefined;
}

function metadataAnnotations(raw: Record<string, unknown>): unknown[] | undefined {
  const openrouter = metadataRecord(raw, 'openrouter');
  if (Array.isArray(raw.annotations)) {
    return raw.annotations;
  }
  if (Array.isArray(openrouter?.annotations)) {
    return openrouter.annotations;
  }
  return undefined;
}

function evidenceFromMetadata(metadata: unknown, acc: StreamAccumulator): TurnEvent | undefined {
  const raw = rawRecord(metadata);
  if (!raw || acc.evidenceSeen) {
    return undefined;
  }
  const citations = nestedCitations(raw);
  const annotations = metadataAnnotations(raw);
  if (!citations && !annotations) {
    return undefined;
  }
  acc.evidenceSeen = true;
  return {
    type: 'evidence',
    evidence: { provider: 'openrouter', raw, citations, annotations },
  };
}

function toolArguments(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (input === undefined) {
    return undefined;
  }
  return { value: input };
}

function isEmptyRecord(input: Record<string, unknown> | undefined): boolean {
  return Boolean(input) && Object.keys(input ?? {}).length === 0;
}

function toolCallArguments(
  part: Extract<TextStreamPart<ToolSet>, { type: 'tool-call' }>,
  acc: StreamAccumulator,
): Record<string, unknown> | undefined {
  const fromInput = toolArguments(part.input);
  const rawInput = acc.toolInputs.get(part.toolCallId);
  if ((!fromInput || isEmptyRecord(fromInput)) && rawInput) {
    return toolArguments(parseToolInput(rawInput));
  }
  return fromInput;
}

function toolResultData(output: unknown): Record<string, unknown> | undefined {
  return rawRecord(output);
}

function rawThoughtEvent(raw: Record<string, unknown>): TurnEvent | undefined {
  const choices = raw.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const delta = rawRecord(rawRecord(choice)?.delta);
    if (typeof delta?.thinking === 'string') {
      return { type: 'thought', text: delta.thinking };
    }
  }
  return undefined;
}

function rawChoiceMessageEvidence(
  raw: Record<string, unknown>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  const choices = raw.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const message = rawRecord(rawRecord(choice)?.message);
    if (!message) {
      continue;
    }
    const evidence = evidenceFromMetadata(message, acc);
    if (evidence) {
      return evidence;
    }
  }
  return undefined;
}

function rawEvents(raw: unknown, acc: StreamAccumulator): TurnEvent[] {
  const record = rawRecord(raw);
  if (!record) {
    return [];
  }
  const events: TurnEvent[] = [];
  const thought = rawThoughtEvent(record);
  if (thought) {
    events.push(thought);
  }
  const evidence = evidenceFromMetadata(record, acc);
  if (evidence) {
    events.push(evidence);
  }
  const messageEvidence = rawChoiceMessageEvidence(record, acc);
  if (messageEvidence) {
    events.push(messageEvidence);
  }
  return events;
}

async function collectRawEvents(res: Response): Promise<TurnEvent[]> {
  if (!res.body) {
    return [];
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: TurnEvent[] = [];
  const acc = createAccumulator();
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
      events.push(...rawEvents(payload, acc));
    }
  }
  return events;
}

function captureFetch(
  config: OpenRouterConfig,
  setCapture: (capture: Promise<TurnEvent[]>) => void,
): typeof fetch {
  const fetchFn = config.fetch ?? fetch;
  return async (input, init) => {
    const res = await fetchFn(input, init);
    setCapture(collectRawEvents(res.clone()).catch(() => []));
    return res;
  };
}

function toolCallEvent(
  part: Extract<TextStreamPart<ToolSet>, { type: 'tool-call' }>,
  acc: StreamAccumulator,
): TurnEvent {
  return {
    type: 'tool',
    tool: {
      name: part.toolName,
      arguments: toolCallArguments(part, acc),
      id: part.toolCallId,
    },
  };
}

function toolResultEvent(
  part: Extract<TextStreamPart<ToolSet>, { type: 'tool-result' }>,
): TurnEvent {
  return {
    type: 'tool',
    tool: {
      name: part.toolName,
      arguments: toolArguments(part.input),
      result: {
        status: 'ok',
        data: toolResultData(part.output),
        finding: typeof part.output === 'string' ? part.output : undefined,
      },
      id: part.toolCallId,
    },
  };
}

function tokenEvent(
  part: Extract<TextStreamPart<ToolSet>, { type: 'finish' }>,
): TurnEvent | undefined {
  const tokens = tokensFromUsage(part.totalUsage);
  return tokens ? { type: 'tokens', tokens } : undefined;
}

function providerMetadataEvent(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  if (!('providerMetadata' in part)) {
    return undefined;
  }
  return evidenceFromMetadata(part.providerMetadata, acc);
}

function appendToolInput(part: TextStreamPart<ToolSet>, acc: StreamAccumulator): boolean {
  if (part.type === 'tool-input-start') {
    acc.toolInputs.set(part.id, '');
    return true;
  }
  if (part.type === 'tool-input-delta') {
    const current = acc.toolInputs.get(part.id) ?? '';
    acc.toolInputs.set(part.id, current + part.delta);
    return true;
  }
  return false;
}

function eventFromPart(part: TextStreamPart<ToolSet>, acc: StreamAccumulator): TurnEvent[] {
  if (appendToolInput(part, acc)) {
    return [];
  }
  const mapped = primaryEventFromPart(part, acc);
  if (mapped) {
    return [mapped];
  }
  const evidence = providerMetadataEvent(part, acc);
  return evidence ? [evidence] : [];
}

function primaryEventFromPart(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  switch (part.type) {
    case 'text-delta':
      acc.text += part.text;
      return { type: 'text', text: part.text };
    case 'reasoning-delta':
      return { type: 'thought', text: part.text };
    case 'tool-call':
      return toolCallEvent(part, acc);
    case 'tool-result':
      return toolResultEvent(part);
    case 'source':
      return sourceEvent(part);
    case 'finish':
      return finishEvent(part, acc);
    case 'error':
      acc.errored = true;
      return toErrorEvent(part.error);
    default:
      return undefined;
  }
}

function finishEvent(
  part: Extract<TextStreamPart<ToolSet>, { type: 'finish' }>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  if (acc.emittedTokens) {
    return undefined;
  }
  const event = tokenEvent(part);
  if (event) {
    acc.emittedTokens = true;
  }
  return event;
}

function emitRawEvents(
  rawCapture: Promise<TurnEvent[]> | undefined,
  acc: StreamAccumulator,
): Promise<TurnEvent[]> {
  return (rawCapture ?? Promise.resolve([])).then((events) =>
    events.filter((event) => {
      if (event.type !== 'evidence') {
        return true;
      }
      if (acc.evidenceSeen) {
        return false;
      }
      acc.evidenceSeen = true;
      return true;
    }),
  );
}

function createStreamContext(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
  apiKey: string,
): OpenRouterStreamContext {
  let rawCapture: Promise<TurnEvent[]> | undefined;
  const openrouter = createOpenRouter({
    apiKey,
    baseURL: config.baseUrl,
    headers: openRouterHeaders(config),
    fetch: captureFetch(config, (capture) => {
      rawCapture = capture;
    }),
    compatibility: 'strict',
  });
  return {
    openrouter,
    modelName: resolveOpenRouterModel(req.model, config.modelMap, {
      apiId: req.apiId,
      openRouterId: req.openRouterId,
    }),
    rawCapture: () => rawCapture,
  };
}

function streamTextOptions(
  req: ProviderCompleteRequest,
  context: OpenRouterStreamContext,
): Parameters<typeof streamText>[0] {
  return {
    model: context.openrouter.chat(context.modelName, openRouterSettings(req)),
    system: req.system,
    messages: buildMessages(req),
    allowSystemInMessages: true,
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    tools: buildTools(req.dynamicTools),
    providerOptions: providerOptionsFor(req),
    includeRawChunks: true,
    abortSignal: req.signal,
    onError: () => undefined,
  };
}

async function* yieldAiSdkStream(
  req: ProviderCompleteRequest,
  acc: StreamAccumulator,
  context: OpenRouterStreamContext,
): AsyncGenerator<TurnEvent> {
  const result = streamText(streamTextOptions(req, context));
  for await (const part of result.fullStream) {
    if (part.type === 'raw') {
      req.tapGemini?.(rawRecord(part.rawValue) ?? { rawValue: part.rawValue });
      for (const event of rawEvents(part.rawValue, acc)) {
        yield event;
      }
      continue;
    }
    for (const event of eventFromPart(part, acc)) {
      yield event;
    }
  }
}

async function* yieldCapturedRawEvents(
  context: OpenRouterStreamContext,
  acc: StreamAccumulator,
): AsyncGenerator<TurnEvent> {
  for (const event of await emitRawEvents(context.rawCapture(), acc)) {
    yield event;
  }
}

async function* yieldCapturedRawEventsUnchecked(
  context: OpenRouterStreamContext,
): AsyncGenerator<TurnEvent> {
  for (const event of await (context.rawCapture() ?? Promise.resolve([]))) {
    yield event;
  }
}

function missingOpenRouterKey(): TurnEvent {
  return toErrorEvent('missing OpenRouter API key');
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
): AsyncGenerator<TurnEvent> {
  const apiKey = trimApiKey(config.apiKey);
  if (!apiKey) {
    yield missingOpenRouterKey();
    return;
  }

  const acc = createAccumulator();
  const context = createStreamContext(req, config, apiKey);
  try {
    yield* yieldAiSdkStream(req, acc, context);
    yield* yieldCapturedRawEvents(context, acc);
    yield* finalEvents(req, acc);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    yield* yieldCapturedRawEventsUnchecked(context);
    yield toErrorEvent(err);
  }
}

function* finalEvents(req: ProviderCompleteRequest, acc: StreamAccumulator): Generator<TurnEvent> {
  if (acc.errored) {
    return;
  }
  if (req.structured && acc.text) {
    const structured = tryStructured(acc.text);
    if (structured) {
      yield structured;
    }
  }
  yield { type: 'done' };
}

function providerOptionsFor(req: ProviderCompleteRequest): ProviderOptions | undefined {
  if (req.thinking === 'none') {
    return undefined;
  }
  return {
    openrouter: {
      reasoning: { effort: req.thinking },
    },
  } as ProviderOptions;
}

function openRouterHeaders(config: OpenRouterConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }
  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Create a `ModelProvider` backed by OpenRouter through AI SDK Core. */
function createOpenRouterProvider(config: OpenRouterConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamOpenRouter(req, config),
  };
}

export type { OpenRouterConfig };
export { createOpenRouterProvider, resolveOpenRouterModel, toOpenRouterPayload };
