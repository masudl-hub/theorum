/**
 * Google Interactions provider adapter.
 *
 * This adapter converts THEORUM's provider-neutral request into the Google
 * Interactions wire format and streams normalized `TurnEvent` objects.
 * Speech-role turns use `response_format: audio` + `speech_config` (same
 * transport as chat/image).
 *
 * @module
 */

import { isAbortError, TheorumError, toErrorEvent } from '../guardrails/error.ts';
import {
  codeExecutionEvidence,
  codeExecutionStepKey,
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  googleBuiltinEvidence,
  groundingFromEvent,
  isCodeExecutionType,
  isGoogleBuiltinStepType,
  mergeCodeExecutionPayload,
  tryStructured,
} from '../kernel/engine/delta.ts';
import { asRecord } from '../kernel/engine/record.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../kernel/types.ts';
import { exposeForTests } from './expose-for-tests.ts';
import { tapFetch } from './google-tap.ts';
import { toInteractionsBody } from './interactions.ts';
import { fetchGemini, type GeminiTransport } from './keys.ts';
import { wrapPcmAsWav } from './pcm.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL, takeSsePayloads } from './sse.ts';

const HTTP_OK = 200;

interface InteractionsFunctionCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface InteractionsStreamFold {
  text: string;
  functionCalls: Map<number, InteractionsFunctionCall>;
  emittedToolKeys: Set<string>;
  emittedEvidenceKeys: Set<string>;
  codeSteps: Map<number, Record<string, unknown>>;
  sawStreamedMedia: boolean;
}

function base64ToBytes(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function isRawPcmMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return lower === 'audio/pcm' || lower === 'audio/l16' || lower === 'audio/raw';
}

/** Google TTS returns raw PCM; wrap as WAV for hosts (matches OpenRouter pcm path). */
function normalizeSpeechMedia(event: TurnEvent, speech: boolean): TurnEvent {
  if (!(speech && event.type === 'media' && event.media)) {
    return event;
  }
  const { mimeType, data } = event.media;
  if (!isRawPcmMime(mimeType)) {
    return event;
  }
  const wav = wrapPcmAsWav(base64ToBytes(data));
  return {
    type: 'media',
    media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
  };
}

async function* readSseRecords(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) {
    throw new TheorumError('empty Gemini stream');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  yield* pumpSse(reader, decoder, '', '');
}

async function* pumpSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  pendingEvent: string,
): AsyncGenerator<Record<string, unknown>> {
  const { done, value } = await reader.read();
  if (done) {
    return;
  }
  const next = buffer + decoder.decode(value, { stream: true });
  const taken = takeSsePayloads(next, pendingEvent);
  for (const payload of taken.payloads) {
    yield payload;
  }
  yield* pumpSse(reader, decoder, taken.rest, taken.pendingEvent);
}

function eventType(event: Record<string, unknown>): string {
  return String(event.event_type ?? event.type ?? '');
}

function isDeltaEvent(kind: string): boolean {
  return kind === 'content.delta' || kind === 'step.delta';
}

function isCompleteEvent(kind: string): boolean {
  return kind === 'interaction.complete' || kind === 'interaction.completed';
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty args when partial JSON is not yet valid.
  }
  return {};
}

function seedFunctionCall(
  step: Record<string, unknown>,
  index: number,
  fold: InteractionsStreamFold,
): void {
  const args = step.arguments;
  let argumentsText = '';
  if (typeof args === 'string') {
    argumentsText = args;
  } else if (args && typeof args === 'object') {
    argumentsText = JSON.stringify(args);
  }
  fold.functionCalls.set(index, {
    id: typeof step.id === 'string' ? step.id : undefined,
    name: typeof step.name === 'string' ? step.name : undefined,
    arguments: argumentsText,
  });
}

function rememberEvidence(
  raw: Record<string, unknown>,
  index: number,
  fold: InteractionsStreamFold,
): boolean {
  const key = codeExecutionStepKey(raw, index);
  if (fold.emittedEvidenceKeys.has(key)) {
    return false;
  }
  fold.emittedEvidenceKeys.add(key);
  return true;
}

function emitCodeExecution(
  raw: Record<string, unknown>,
  index: number,
  fold: InteractionsStreamFold,
  options: { skipIfSeen: boolean },
): TurnEvent[] {
  if (options.skipIfSeen && !rememberEvidence(raw, index, fold)) {
    return [];
  }
  if (!options.skipIfSeen) {
    fold.emittedEvidenceKeys.add(codeExecutionStepKey(raw, index));
  }
  return [codeExecutionEvidence(raw)];
}

function codeExecutionHasPayload(merged: Record<string, unknown>): boolean {
  return Boolean(
    asRecord(merged.arguments)?.code || merged.result || typeof merged.arguments === 'string',
  );
}

function foldCodeExecutionStart(
  step: Record<string, unknown>,
  index: number,
  fold: InteractionsStreamFold,
): TurnEvent[] {
  fold.codeSteps.set(index, mergeCodeExecutionPayload(fold.codeSteps.get(index), step));
  const merged = fold.codeSteps.get(index) ?? step;
  if (!codeExecutionHasPayload(merged)) {
    return [];
  }
  return emitCodeExecution(merged, index, fold, { skipIfSeen: false });
}

function foldStepStart(event: Record<string, unknown>, fold: InteractionsStreamFold): TurnEvent[] {
  const step = asRecord(event.step);
  if (!step) {
    return [];
  }
  const index = Number(event.index ?? 0);
  if (String(step.type ?? '') === 'function_call') {
    seedFunctionCall(step, index, fold);
    return [];
  }
  if (!isCodeExecutionType(String(step.type ?? ''))) {
    return [];
  }
  return foldCodeExecutionStart(step, index, fold);
}

function foldStepStop(event: Record<string, unknown>, fold: InteractionsStreamFold): TurnEvent[] {
  const index = Number(event.index ?? 0);
  const step = asRecord(event.step) ?? fold.codeSteps.get(index);
  if (!step || !isCodeExecutionType(String(step.type ?? fold.codeSteps.get(index)?.type ?? ''))) {
    const assembled = fold.codeSteps.get(index);
    if (!assembled) {
      return [];
    }
    return emitCodeExecution(assembled, index, fold, { skipIfSeen: true });
  }
  const merged = mergeCodeExecutionPayload(fold.codeSteps.get(index), step);
  fold.codeSteps.set(index, merged);
  return emitCodeExecution(merged, index, fold, { skipIfSeen: true });
}

function accumulateFunctionArguments(
  event: Record<string, unknown>,
  delta: Record<string, unknown>,
  fold: InteractionsStreamFold,
): void {
  const index = Number(event.index ?? 0);
  const partial = delta.partial_arguments ?? delta.arguments_delta ?? delta.arguments ?? '';
  const existing = fold.functionCalls.get(index) ?? { arguments: '' };
  existing.arguments += typeof partial === 'string' ? partial : JSON.stringify(partial);
  fold.functionCalls.set(index, existing);
}

function foldCodeExecutionDelta(
  event: Record<string, unknown>,
  delta: Record<string, unknown>,
  fold: InteractionsStreamFold,
): TurnEvent[] {
  const index = Number(event.index ?? 0);
  const merged = mergeCodeExecutionPayload(fold.codeSteps.get(index), delta);
  fold.codeSteps.set(index, merged);
  fold.emittedEvidenceKeys.add(codeExecutionStepKey(merged, index));
  return [codeExecutionEvidence(merged)];
}

function recordStreamedDeltaEvents(deltaEvents: TurnEvent[], fold: InteractionsStreamFold): void {
  for (const item of deltaEvents) {
    if (item.type === 'text' && item.text) {
      fold.text += item.text;
    }
    if (item.type === 'media') {
      fold.sawStreamedMedia = true;
    }
  }
}

function foldDeltaPayload(
  event: Record<string, unknown>,
  fold: InteractionsStreamFold,
): TurnEvent[] {
  const delta = asRecord(event.delta);
  if (!delta) {
    return [];
  }
  const deltaType = String(delta.type ?? '');
  if (deltaType === 'arguments' || deltaType === 'arguments_delta') {
    accumulateFunctionArguments(event, delta, fold);
    return [];
  }
  if (isCodeExecutionType(deltaType)) {
    return foldCodeExecutionDelta(event, delta, fold);
  }
  const deltaEvents = eventsFromDelta(delta);
  recordStreamedDeltaEvents(deltaEvents, fold);
  return deltaEvents;
}

function toolEventsFromFunctionCalls(fold: InteractionsStreamFold): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const [index, call] of fold.functionCalls) {
    const key = call.id ?? `${call.name ?? 'tool'}_${String(index)}`;
    if (fold.emittedToolKeys.has(key) || !call.name) {
      continue;
    }
    fold.emittedToolKeys.add(key);
    events.push({
      type: 'tool',
      tool: {
        id: call.id,
        name: call.name,
        arguments: parseToolArguments(call.arguments),
      },
    });
  }
  return events;
}

function functionCallsFromInteractionSteps(
  interaction: Record<string, unknown>,
  fold: InteractionsStreamFold,
): void {
  const steps = interaction.steps;
  if (!Array.isArray(steps)) {
    return;
  }
  for (const [index, stepValue] of steps.entries()) {
    const step = asRecord(stepValue);
    if (!step || String(step.type ?? '') !== 'function_call') {
      continue;
    }
    seedFunctionCall(step, index, fold);
  }
}

function interactionStatus(event: Record<string, unknown>): string | undefined {
  const interaction = asRecord(event.interaction) ?? event;
  const status = interaction.status ?? event.status;
  return typeof status === 'string' ? status.toLowerCase() : undefined;
}

function foldStatusUpdate(
  event: Record<string, unknown>,
  fold: InteractionsStreamFold,
): TurnEvent[] {
  const interaction = asRecord(event.interaction) ?? event;
  functionCallsFromInteractionSteps(interaction, fold);
  if (interactionStatus(event) !== 'requires_action') {
    return [];
  }
  return toolEventsFromFunctionCalls(fold);
}

function skipDuplicateGoogleEvidence(item: TurnEvent, fold: InteractionsStreamFold): boolean {
  const raw = item.evidence?.raw;
  if (item.type !== 'evidence' || !raw) {
    return false;
  }
  const type = String(item.evidence?.kind ?? raw.type ?? '');
  if (!isCodeExecutionType(type) && !isGoogleBuiltinStepType(type)) {
    return false;
  }
  const key = codeExecutionStepKey(raw);
  if (fold.emittedEvidenceKeys.has(key)) {
    return true;
  }
  fold.emittedEvidenceKeys.add(key);
  return false;
}

function foldCompletePayload(
  event: Record<string, unknown>,
  fold: InteractionsStreamFold,
): TurnEvent[] {
  const interaction = asRecord(event.interaction) ?? event;
  functionCallsFromInteractionSteps(interaction, fold);
  const events: TurnEvent[] = [];
  for (const item of eventsFromComplete(event, fold.text.length > 0)) {
    if (item.type === 'media' && fold.sawStreamedMedia) {
      continue;
    }
    if (skipDuplicateGoogleEvidence(item, fold)) {
      continue;
    }
    events.push(item);
  }
  if (interactionStatus(event) === 'requires_action') {
    events.push(...toolEventsFromFunctionCalls(fold));
  }
  return events;
}

function foldKindEvents(event: Record<string, unknown>, fold: InteractionsStreamFold): TurnEvent[] {
  const kind = eventType(event);
  if (kind === 'step.start') {
    return foldStepStart(event, fold);
  }
  if (kind === 'step.stop') {
    return foldStepStop(event, fold);
  }
  if (isDeltaEvent(kind)) {
    return foldDeltaPayload(event, fold);
  }
  if (kind === 'interaction.status_update') {
    return foldStatusUpdate(event, fold);
  }
  if (isCompleteEvent(kind)) {
    return foldCompletePayload(event, fold);
  }
  return [];
}

function appendGoogleEvidenceIfMissing(
  event: Record<string, unknown>,
  fold: InteractionsStreamFold,
  events: TurnEvent[],
): void {
  if (events.some((e) => e.type === 'evidence')) {
    return;
  }
  const evidenceEvent = evidenceFromGooglePayload(event);
  if (!evidenceEvent) {
    return;
  }
  const raw = evidenceEvent.evidence?.raw;
  if (!raw || rememberEvidence(raw, Number(event.index ?? 0), fold)) {
    events.push(evidenceEvent);
  }
}

function appendStreamExtras(
  event: Record<string, unknown>,
  fold: InteractionsStreamFold,
  events: TurnEvent[],
): void {
  if (!events.some((e) => e.type === 'tokens')) {
    const tokenEvent = extractTokenEvent(event);
    if (tokenEvent) {
      events.push(tokenEvent);
    }
  }
  const groundingEvent = groundingFromEvent(event);
  if (groundingEvent && !events.some((e) => e.type === 'grounding')) {
    events.push(groundingEvent);
  }
  appendGoogleEvidenceIfMissing(event, fold, events);
}

function foldPayload(event: Record<string, unknown>, fold: InteractionsStreamFold): TurnEvent[] {
  const events = foldKindEvents(event, fold);
  appendStreamExtras(event, fold, events);
  return events;
}

/** Preserve raw Google Interactions tool payloads so hosts can inspect everything returned. */
function evidenceFromGooglePayload(event: Record<string, unknown>): TurnEvent | undefined {
  for (const key of ['delta', 'step'] as const) {
    const payload = asRecord(event[key]);
    if (!payload) {
      continue;
    }
    const type = String(payload.type ?? '');
    if (isGoogleBuiltinStepType(type)) {
      return googleBuiltinEvidence(payload);
    }
    if (isCodeExecutionType(type)) {
      return codeExecutionEvidence(payload);
    }
  }
  return undefined;
}

function withTap(req: ProviderCompleteRequest, transport: GeminiTransport): GeminiTransport {
  return {
    ...transport,
    fetch: tapFetch(req.tapGemini, transport.fetch),
  };
}

function newStreamFold(): InteractionsStreamFold {
  return {
    text: '',
    functionCalls: new Map(),
    emittedToolKeys: new Set(),
    emittedEvidenceKeys: new Set(),
    codeSteps: new Map(),
    sawStreamedMedia: false,
  };
}

function* yieldFoldedSpeechEvents(
  payload: Record<string, unknown>,
  fold: InteractionsStreamFold,
  speech: boolean,
): Generator<TurnEvent> {
  for (const event of foldPayload(payload, fold)) {
    yield normalizeSpeechMedia(event, speech);
  }
}

function completedPayloadFromJson(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw) ?? {};
  if (record.event_type) {
    return record;
  }
  return { event_type: 'interaction.completed', interaction: record.interaction ?? record };
}

async function* streamBatchedComplete(
  req: ProviderCompleteRequest,
  res: Response,
  fold: InteractionsStreamFold,
  speech: boolean,
): AsyncGenerator<TurnEvent> {
  const raw: unknown = await res.json().catch(() => ({}));
  const record = asRecord(raw) ?? {};
  req.tapGemini?.(record);
  yield* yieldFoldedSpeechEvents(completedPayloadFromJson(raw), fold, speech);
}

async function* streamSseComplete(
  req: ProviderCompleteRequest,
  res: Response,
  fold: InteractionsStreamFold,
  speech: boolean,
): AsyncGenerator<TurnEvent> {
  for await (const payload of readSseRecords(res)) {
    req.tapGemini?.(payload);
    yield* yieldFoldedSpeechEvents(payload, fold, speech);
  }
}

function* maybeStructuredFromFold(
  req: ProviderCompleteRequest,
  fold: InteractionsStreamFold,
): Generator<TurnEvent> {
  if (!req.structured || !fold.text) {
    return;
  }
  const structured = tryStructured(fold.text);
  if (structured) {
    yield structured;
  }
}

async function fetchInteractionsResponse(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
  streaming: boolean,
): Promise<Response> {
  return await fetchGemini(
    streaming ? INTERACTIONS_URL : INTERACTIONS_JSON_URL,
    { method: 'POST', body: JSON.stringify(toInteractionsBody(req)), signal: req.signal },
    req.geminiBucket ?? 'freeA',
    withTap(req, transport),
  );
}

async function* streamComplete(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  if (!req.geminiBucket) {
    yield toErrorEvent('missing Gemini vault bucket for Interactions');
    return;
  }
  const streaming = req.stream !== false;
  const res = await fetchInteractionsResponse(req, transport, streaming);
  if (res.status !== HTTP_OK) {
    const errorBody = await res.text().catch(() => '');
    yield toErrorEvent(`Gemini HTTP ${String(res.status)}: ${errorBody}`);
    return;
  }
  const fold = newStreamFold();
  const speech = Boolean(req.speech);
  if (streaming) {
    yield* streamSseComplete(req, res, fold, speech);
  } else {
    yield* streamBatchedComplete(req, res, fold, speech);
  }
  yield* maybeStructuredFromFold(req, fold);
}

async function* streamGuarded(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  try {
    yield* streamComplete(req, transport);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    yield toErrorEvent(err);
  }
}

/** Create a `ModelProvider` backed by Google Interactions streaming. */
function createInteractionsProvider(transport: GeminiTransport): ModelProvider {
  return {
    complete: (req) => streamGuarded(req, transport),
  };
}

export { createInteractionsProvider };

exposeForTests('provider', {
  base64ToBytes,
  bytesToBase64,
  isRawPcmMime,
  normalizeSpeechMedia,
  eventType,
  isDeltaEvent,
  isCompleteEvent,
  parseToolArguments,
  seedFunctionCall,
  foldStepStart,
  foldStepStop,
  foldDeltaPayload,
  toolEventsFromFunctionCalls,
  functionCallsFromInteractionSteps,
  foldPayload,
  evidenceFromGooglePayload,
  withTap,
  newStreamFold,
});
