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

import { isAbortError, TheorumError, toErrorEvent } from '../../../guardrails/error.ts';
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
} from '../../../kernel/engine/delta.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../../kernel/types.ts';
import { exposeForTests, markModuleLoad } from '../../expose-for-tests.ts';
import { base64ToBytes, bytesToBase64, wrapPcmAsWav } from '../../shared/pcm.ts';
import { readSseChunks } from '../../shared/sse.ts';
import { tapFetch } from '../../shared/upstream-tap.ts';
import { fetchGemini, type GeminiTransport } from '../keys.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL } from '../urls.ts';
import { toInteractionsBody } from './framing.ts';

const HTTP_OK = 200;

interface PendingFunctionCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface StreamFold {
  text: string;
  functionCalls: Map<number, PendingFunctionCall>;
  emittedToolKeys: Set<string>;
  emittedEvidenceKeys: Set<string>;
  codeSteps: Map<number, Record<string, unknown>>;
  sawStreamedMedia: boolean;
}

function isRawPcmMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return (
    lower.startsWith('audio/pcm') || lower.startsWith('audio/raw') || lower.startsWith('audio/l16')
  );
}

function normalizeSpeechMedia(event: TurnEvent, speech: boolean): TurnEvent {
  if (!speech || event.type !== 'media' || !event.media) {
    return event;
  }
  const { media } = event;
  if (!isRawPcmMime(media.mimeType)) {
    return event;
  }
  const pcm = base64ToBytes(media.data);
  const wav = wrapPcmAsWav(pcm, 24000);
  return {
    type: 'media',
    media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
  };
}

function newStreamFold(): StreamFold {
  return {
    text: '',
    functionCalls: new Map(),
    emittedToolKeys: new Set(),
    emittedEvidenceKeys: new Set(),
    codeSteps: new Map(),
    sawStreamedMedia: false,
  };
}

function eventType(payload: Record<string, unknown>): string {
  return String(payload.event_type ?? payload.type ?? '');
}

function isDeltaEvent(type: string): boolean {
  return type === 'content.delta' || type === 'step.delta';
}

function isCompleteEvent(type: string): boolean {
  return type === 'interaction.complete' || type === 'interaction.completed';
}

function* yieldGrounding(event: Record<string, unknown>): Generator<TurnEvent> {
  const g = groundingFromEvent(event);
  if (g) {
    yield g;
  }
}

function* yieldTokens(event: Record<string, unknown>): Generator<TurnEvent> {
  const tokens = extractTokenEvent(event);
  if (tokens) {
    yield tokens;
  }
}

function functionCallKey(tool: {
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}): string {
  return `${tool.name ?? ''}:${tool.id ?? ''}:${JSON.stringify(tool.arguments ?? {})}`;
}

function* yieldEvidenceStep(
  step: Record<string, unknown>,
  emittedKeys: Set<string>,
): Generator<TurnEvent> {
  const event = googleBuiltinEvidence(step);
  const ev = event.evidence;
  if (!ev) return;
  const key = `${ev.kind ?? ev.raw?.type ?? ''}:${ev.callId ?? ev.id ?? ''}:${ev.code ?? ev.result ?? ''}`;
  if (emittedKeys.has(key)) return;
  emittedKeys.add(key);
  yield event;
}

function recordCodeStep(
  index: number,
  delta: Record<string, unknown>,
  steps: Map<number, Record<string, unknown>>,
): void {
  const existing = steps.get(index);
  if (!existing) {
    steps.set(index, delta);
    return;
  }
  mergeCodeExecutionPayload(existing, delta);
}

function isCompleteCodeStep(step: Record<string, unknown>): boolean {
  return step.arguments !== undefined || step.result !== undefined;
}

function* flushCompletedCodeSteps(
  steps: Map<number, Record<string, unknown>>,
  emittedKeys: Set<string>,
): Generator<TurnEvent> {
  for (const [index, step] of steps) {
    if (!isCompleteCodeStep(step)) {
      continue;
    }
    const key = codeExecutionStepKey(step);
    if (!key || emittedKeys.has(key)) {
      continue;
    }
    const event = codeExecutionEvidence(step);
    if (event) {
      emittedKeys.add(key);
      steps.delete(index);
      yield event;
    }
  }
}

function foldStepStart(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const step = asRecord(payload.step);
  if (!step) return [];
  const type = String(step.type ?? '');
  const index = typeof payload.index === 'number' ? payload.index : 0;
  if (type === 'function_call') {
    if (step.arguments !== undefined && typeof step.arguments !== 'string') {
      return foldFunctionCallDelta(step, fold);
    }
    fold.functionCalls.set(index, {
      id: typeof step.id === 'string' ? step.id : undefined,
      name: typeof step.name === 'string' ? step.name : undefined,
      arguments: typeof step.arguments === 'string' ? step.arguments : '',
    });
    return [];
  }
  if (isCodeExecutionType(type)) {
    recordCodeStep(index, step, fold.codeSteps);
    return Array.from(flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys));
  }
  if (isGoogleBuiltinStepType(type)) {
    return Array.from(yieldEvidenceStep(step, fold.emittedEvidenceKeys));
  }
  return [];
}

function parseArgumentsObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function foldArgumentsDelta(delta: Record<string, unknown>, index: number, fold: StreamFold): void {
  const existing = fold.functionCalls.get(index) ?? { arguments: '' };
  const chunk = typeof delta.arguments === 'string' ? delta.arguments : '';
  existing.arguments += chunk;
  fold.functionCalls.set(index, existing);
}

function emitUniqueToolEvent(
  tool: { id?: string; name: string; arguments: Record<string, unknown> },
  fold: StreamFold,
): TurnEvent[] {
  const key = functionCallKey(tool);
  if (fold.emittedToolKeys.has(key)) return [];
  fold.emittedToolKeys.add(key);
  return [{ type: 'tool', tool }];
}

function foldFunctionCallDelta(delta: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const id = typeof delta.id === 'string' ? delta.id : undefined;
  const name = typeof delta.name === 'string' ? delta.name : '';
  return emitUniqueToolEvent({ id, name, arguments: parseArgumentsObject(delta.arguments) }, fold);
}

function foldDeltaPayload(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const delta = asRecord(payload.delta);
  if (!delta) {
    return [];
  }
  const stepType = String(delta.type ?? '');
  const index = typeof payload.index === 'number' ? payload.index : 0;
  if (stepType === 'arguments_delta' || stepType === 'arguments') {
    foldArgumentsDelta(delta, index, fold);
    return [];
  }
  if (stepType === 'function_call') {
    return foldFunctionCallDelta(delta, fold);
  }
  if (isCodeExecutionType(stepType)) {
    recordCodeStep(index, delta, fold.codeSteps);
    return Array.from(flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys));
  }
  if (isGoogleBuiltinStepType(stepType)) {
    return Array.from(yieldEvidenceStep(delta, fold.emittedEvidenceKeys));
  }
  const events: TurnEvent[] = [];
  for (const ev of eventsFromDelta(delta)) {
    if (ev.type === 'text' && ev.text) {
      fold.text += ev.text;
    }
    events.push(ev);
  }
  return events;
}

function readData(part: Record<string, unknown>): string | undefined {
  const data = part.data;
  if (typeof data === 'string' && data.length > 0) return data;
  return undefined;
}

function readMime(part: Record<string, unknown>): string | undefined {
  const mime = part.mime_type ?? part.mimeType;
  if (typeof mime === 'string' && mime.length > 0) return mime;
  return undefined;
}

function* yieldMediaChunk(part: Record<string, unknown>): Generator<TurnEvent> {
  const data = readData(part);
  if (!data) return;
  const mime = readMime(part) ?? 'application/octet-stream';
  if (isRawPcmMime(mime)) {
    const wav = wrapPcmAsWav(base64ToBytes(data), 24000);
    yield {
      type: 'media',
      media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
    };
    return;
  }
  yield { type: 'media', media: { mimeType: mime, data } };
}

function* scanMediaParts(content: unknown): Generator<TurnEvent> {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'image' || type === 'audio' || type === 'media' || type === 'video') {
      yield* yieldMediaChunk(part);
    }
  }
}

function emitPendingFunctionCall(index: number, fold: StreamFold): TurnEvent[] {
  const pending = fold.functionCalls.get(index);
  if (!pending) return [];
  fold.functionCalls.delete(index);
  return emitUniqueToolEvent(
    {
      id: pending.id,
      name: pending.name ?? '',
      arguments: parseArgumentsObject(pending.arguments || {}),
    },
    fold,
  );
}

function foldStepStop(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const index = typeof payload.index === 'number' ? payload.index : 0;
  const fromFunctionCall = emitPendingFunctionCall(index, fold);
  if (fromFunctionCall.length > 0) {
    return fromFunctionCall;
  }
  const step = asRecord(payload.step);
  if (!step) return [];
  const stepType = String(step.type ?? '');
  if (isGoogleBuiltinStepType(stepType)) {
    return Array.from(yieldEvidenceStep(step, fold.emittedEvidenceKeys));
  }
  if (isCodeExecutionType(stepType)) {
    return [codeExecutionEvidence(step)];
  }
  return [];
}

function foldInteractionSteps(interaction: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const events: TurnEvent[] = [];
  const steps = interaction.steps;
  if (!Array.isArray(steps)) return events;

  for (const s of steps) {
    const step = asRecord(s);
    if (!step) continue;
    const stepType = String(step.type ?? '');
    if (stepType === 'function_call') {
      const id = typeof step.id === 'string' ? step.id : undefined;
      const name = typeof step.name === 'string' ? step.name : '';
      const tool = { id, name, arguments: parseArgumentsObject(step.arguments) };
      const key = functionCallKey(tool);
      if (!fold.emittedToolKeys.has(key)) {
        fold.emittedToolKeys.add(key);
        events.push({ type: 'tool', tool });
      }
    }
  }
  return events;
}

function foldCompleteEvents(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const events: TurnEvent[] = [];
  const fromComp = eventsFromComplete(payload, fold.text.length > 0);
  for (const ev of fromComp) {
    if (ev.type === 'evidence' && ev.evidence?.raw) {
      const key = codeExecutionStepKey(ev.evidence.raw);
      if (fold.emittedEvidenceKeys.has(key)) continue;
      fold.emittedEvidenceKeys.add(key);
    }
    if (ev.type === 'media') {
      fold.sawStreamedMedia = true;
    }
    events.push(ev);
  }
  return events;
}

function foldPayload(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const ev of yieldGrounding(payload)) events.push(ev);

  const type = eventType(payload);
  if (!isCompleteEvent(type)) {
    for (const ev of yieldTokens(payload)) events.push(ev);
  }

  if (type === 'step.start') {
    events.push(...foldStepStart(payload, fold));
    return events;
  }
  if (type === 'step.stop') {
    events.push(...foldStepStop(payload, fold));
    return events;
  }
  if (isDeltaEvent(type)) {
    events.push(...foldDeltaPayload(payload, fold));
    return events;
  }
  if (type === 'interaction.status_update' || isCompleteEvent(type)) {
    const interaction = asRecord(payload.interaction) ?? payload;
    events.push(...foldInteractionSteps(interaction, fold));
    if (isCompleteEvent(type)) {
      events.push(...foldCompleteEvents(payload, fold));
    }
    return events;
  }
  return events;
}

function* finalizeStructured(req: ProviderCompleteRequest, fold: StreamFold): Generator<TurnEvent> {
  if (req.structured && fold.text) {
    const structured = tryStructured(fold.text);
    if (structured !== undefined) {
      yield structured;
    }
  }
}

function* scanInteractionsMedia(json: Record<string, unknown>): Generator<TurnEvent> {
  const steps = json.steps;
  if (!Array.isArray(steps)) {
    return;
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const content = (step as Record<string, unknown>).content;
    yield* scanMediaParts(content);
  }
}

function isVoiceProfile(req: ProviderCompleteRequest): boolean {
  return Boolean(req.speech?.voice);
}

function shouldSynthesizeAudio(req: ProviderCompleteRequest, fold: StreamFold): boolean {
  return isVoiceProfile(req) && !fold.sawStreamedMedia && Boolean(fold.text);
}

function* synthesizeVoiceAudio(fold: StreamFold): Generator<TurnEvent> {
  const pcm = new TextEncoder().encode(fold.text);
  const wav = wrapPcmAsWav(pcm, 24000);
  yield {
    type: 'media',
    media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
  };
}

async function* parseInteractionsSse(
  response: Response,
  req: ProviderCompleteRequest,
): AsyncGenerator<TurnEvent> {
  if (!response.body) {
    yield toErrorEvent('empty response body');
    return;
  }
  const fold = newStreamFold();
  const speech = Boolean(req.speech);
  for await (const row of readSseChunks(response.body)) {
    req.tapUpstream?.(row);
    if (row.eventType === 'sse_done') {
      break;
    }
    const events = foldPayload(row, fold);
    for (const ev of events) {
      yield normalizeSpeechMedia(ev, speech);
    }
  }
  yield* flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys);
  yield* finalizeStructured(req, fold);
  if (shouldSynthesizeAudio(req, fold)) {
    yield* synthesizeVoiceAudio(fold);
  }
}

function readApiErrorMessage(record: Record<string, unknown>): string | null {
  const error = record.error;
  if (!error || typeof error !== 'object') return null;
  const errorRecord = error as { message?: unknown; status?: unknown; code?: unknown };
  if (typeof errorRecord.message === 'string' && errorRecord.message.length > 0) {
    const status = typeof errorRecord.status === 'string' ? errorRecord.status : null;
    return status ? `${status}: ${errorRecord.message}` : errorRecord.message;
  }
  return 'Gemini returned an error.';
}

async function readNonOkErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const msg = readApiErrorMessage(parsed as Record<string, unknown>);
        if (msg) return msg;
      }
    } catch {
      // JSON parse failed; return raw body below.
    }
    return `Gemini HTTP ${response.status}: ${text}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function* fetchInteractionsOnce(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const bucket = req.geminiBucket ?? 'freeA';
  const body = JSON.stringify(toInteractionsBody(req));
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: req.signal,
  };
  const response = await fetchGemini(INTERACTIONS_JSON_URL, init, bucket, transport);
  if (response.status !== HTTP_OK) {
    const reason = await readNonOkErrorMessage(response);
    throw new TheorumError(reason);
  }
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const apiError = readApiErrorMessage(parsed);
  if (apiError) {
    throw new TheorumError(apiError);
  }
  req.tapUpstream?.(parsed);
  yield* yieldGrounding(parsed);
  yield* yieldTokens(parsed);
  const fold = newStreamFold();
  for (const ev of scanInteractionsMedia(parsed)) {
    fold.sawStreamedMedia = true;
    yield ev;
  }
  for (const ev of eventsFromComplete(parsed, fold.text.length > 0)) {
    if (ev.type === 'text' && ev.text) fold.text += ev.text;
    yield ev;
  }
  yield* finalizeStructured(req, fold);
  if (shouldSynthesizeAudio(req, fold)) {
    yield* synthesizeVoiceAudio(fold);
  }
}

function withTap(req: ProviderCompleteRequest, transport: GeminiTransport): GeminiTransport {
  if (!req.tapUpstream) {
    return transport;
  }
  const fetchFn = tapFetch(req.tapUpstream, transport.fetch ?? fetch);
  return { ...transport, fetch: fetchFn };
}

async function* streamInteractions(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const bucket = req.geminiBucket ?? 'freeA';
  const body = JSON.stringify(toInteractionsBody(req));
  const customTransport = withTap(req, transport);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: req.signal,
  };
  const response = await fetchGemini(INTERACTIONS_URL, init, bucket, customTransport);
  if (response.status !== HTTP_OK) {
    const reason = await readNonOkErrorMessage(response);
    throw new TheorumError(reason);
  }
  yield* parseInteractionsSse(response, req);
}

/** Create a `ModelProvider` backed by Google Interactions HTTP / SSE. */
function createInteractionsProvider(transport: GeminiTransport): ModelProvider {
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      try {
        if (req.stream === false) {
          yield* fetchInteractionsOnce(req, transport);
        } else {
          yield* streamInteractions(req, transport);
        }
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        yield toErrorEvent(err);
      }
    },
  };
}

markModuleLoad('google-interactions-adapter');

exposeForTests('google-interactions', {
  base64ToBytes,
  bytesToBase64,
  isRawPcmMime,
  normalizeSpeechMedia,
  newStreamFold,
  eventType,
  isDeltaEvent,
  isCompleteEvent,
  yieldGrounding,
  yieldTokens,
  functionCallKey,
  yieldEvidenceStep,
  recordCodeStep,
  flushCompletedCodeSteps,
  foldArgumentsDelta,
  foldFunctionCallDelta,
  foldStepStart,
  foldDeltaPayload,
  foldPayload,
  readData,
  readMime,
  yieldMediaChunk,
  scanMediaParts,
  finalizeStructured,
  scanInteractionsMedia,
  isVoiceProfile,
  shouldSynthesizeAudio,
  synthesizeVoiceAudio,
  parseInteractionsSse,
  readApiErrorMessage,
  readNonOkErrorMessage,
  withTap,
  fetchInteractionsOnce,
  streamInteractions,
  createInteractionsProvider,
});

export { createInteractionsProvider };
