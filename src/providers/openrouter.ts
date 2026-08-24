/**
 * OpenRouter-compatible streaming provider adapter.
 *
 * This module maps THEORUM requests to OpenAI-style chat completions, including
 * reasoning deltas, tool calls, citations, structured output, and token usage.
 *
 * @module
 */

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
  evidenceSeen: boolean;
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

  const evidence = evidenceFromRecord(delta);
  if (evidence && !acc.evidenceSeen) {
    acc.evidenceSeen = true;
    events.push(evidence);
  }

  return events;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function firstEvidenceRaw(record: Record<string, unknown>): unknown {
  for (const key of [
    'annotations',
    'citations',
    'search_results',
    'searchResults',
    'provider_metadata',
    'providerMetadata',
  ]) {
    const value = record[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function evidenceCitations(record: Record<string, unknown>): string[] | undefined {
  return (
    stringArray(record.citations) ??
    stringArray(recordField(record, 'provider_metadata')?.citations) ??
    stringArray(recordField(record, 'providerMetadata')?.citations)
  );
}

function evidenceAnnotations(record: Record<string, unknown>): unknown[] | undefined {
  return Array.isArray(record.annotations) ? record.annotations : undefined;
}

function evidenceFromRecord(record: Record<string, unknown>): TurnEvent | undefined {
  if (firstEvidenceRaw(record) === undefined) {
    return undefined;
  }
  return {
    type: 'evidence',
    evidence: {
      provider: 'openrouter',
      raw: record,
      citations: evidenceCitations(record),
      annotations: evidenceAnnotations(record),
    },
  };
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

async function postOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
  apiKey: string,
): Promise<Response> {
  const baseUrl = config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const fetchFn = config.fetch ?? fetch;
  const headers = buildHeaders(apiKey, config);
  const body = JSON.stringify(toOpenRouterPayload(req, config));
  return await fetchFn(url, { method: 'POST', headers, body });
}

function processChoiceDeltas(choices: unknown, acc: StreamAccumulator): TurnEvent[] {
  if (!Array.isArray(choices)) {
    return [];
  }
  const events: TurnEvent[] = [];
  for (const choice of choices) {
    events.push(...processChoiceDelta(choice, acc));
  }
  return events;
}

function processChoiceDelta(choice: unknown, acc: StreamAccumulator): TurnEvent[] {
  if (!choice || typeof choice !== 'object') {
    return [];
  }
  const c = choice as Record<string, unknown>;
  const events = processChoiceDeltaPayload(c.delta, acc);
  const evidence = evidenceFromChoiceMessage(c.message, acc);
  if (evidence) {
    events.push(evidence);
  }
  return events;
}

function processChoiceDeltaPayload(delta: unknown, acc: StreamAccumulator): TurnEvent[] {
  if (!delta || typeof delta !== 'object') {
    return [];
  }
  return processDelta(delta as Record<string, unknown>, acc);
}

function evidenceFromChoiceMessage(
  message: unknown,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const evidence = evidenceFromRecord(message as Record<string, unknown>);
  if (!evidence || acc.evidenceSeen) {
    return undefined;
  }
  acc.evidenceSeen = true;
  return evidence;
}

function* yieldRemainingStreamEvents(
  req: ProviderCompleteRequest,
  acc: StreamAccumulator,
): Generator<TurnEvent> {
  for (const ev of emitRemainingTools(acc)) {
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

function evidenceFromPayload(
  payload: Record<string, unknown>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  const evidence = evidenceFromRecord(payload);
  if (!evidence || acc.evidenceSeen) {
    return undefined;
  }
  acc.evidenceSeen = true;
  return evidence;
}

function* eventsFromPayload(
  payload: Record<string, unknown>,
  acc: StreamAccumulator,
): Generator<TurnEvent> {
  const evidence = evidenceFromPayload(payload, acc);
  if (evidence) {
    yield evidence;
  }
  for (const ev of processChoiceDeltas(payload.choices, acc)) {
    yield ev;
  }
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenRouterConfig,
): AsyncGenerator<TurnEvent> {
  const apiKey = trimApiKey(config.apiKey);
  if (!apiKey) {
    yield { type: 'error', error: publicError('missing OpenRouter API key') };
    return;
  }

  try {
    const res = await postOpenRouter(req, config, apiKey);
    if (res.status !== HTTP_OK) {
      yield { type: 'error', error: publicError(`OpenRouter HTTP ${String(res.status)}`) };
      return;
    }

    const acc: StreamAccumulator = { text: '', toolCalls: new Map(), evidenceSeen: false };
    let emittedTokens = false;
    let sawPayload = false;

    for await (const payload of readSseLines(res)) {
      sawPayload = true;
      req.tapGemini?.(payload);
      for (const ev of eventsFromPayload(payload, acc)) {
        yield ev;
      }

      const usage = parseUsage(payload.usage);
      if (usage && !emittedTokens) {
        emittedTokens = true;
        yield { type: 'tokens', tokens: usage };
      }
    }

    if (!sawPayload) {
      yield { type: 'error', error: publicError('empty OpenRouter stream') };
      return;
    }

    yield* yieldRemainingStreamEvents(req, acc);
  } catch (err) {
    yield { type: 'error', error: publicError(err) };
  }
}

function trimApiKey(explicitKey?: string): string | undefined {
  if (explicitKey?.trim()) {
    return explicitKey.trim();
  }
  return undefined;
}

/** Create a `ModelProvider` backed by OpenRouter-compatible chat completions. */
function createOpenRouterProvider(config: OpenRouterConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamOpenRouter(req, config),
  };
}

export type { OpenRouterConfig };
export { createOpenRouterProvider, resolveOpenRouterModel, toOpenRouterPayload };
