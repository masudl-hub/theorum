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
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  groundingFromEvent,
  tryStructured,
} from '../kernel/engine/delta.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../kernel/types.ts';
import { tapFetch } from './google-tap.ts';
import { toInteractionsBody } from './interactions.ts';
import { fetchGemini, type GeminiTransport } from './keys.ts';
import { wrapPcmAsWav } from './pcm.ts';
import { INTERACTIONS_URL, takeSsePayloads } from './sse.ts';

const HTTP_OK = 200;

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
  return (
    kind === 'interaction.complete' ||
    kind === 'interaction.completed' ||
    kind.startsWith('interaction.')
  );
}

function foldDeltaPayload(event: Record<string, unknown>, acc: { text: string }): TurnEvent[] {
  const deltaEvents = eventsFromDelta(event.delta);
  for (const item of deltaEvents) {
    if (item.type === 'text' && item.text) {
      acc.text += item.text;
    }
  }
  return deltaEvents;
}

function foldPayload(event: Record<string, unknown>, acc: { text: string }): TurnEvent[] {
  const kind = eventType(event);
  const events: TurnEvent[] = [];
  if (isDeltaEvent(kind)) {
    events.push(...foldDeltaPayload(event, acc));
  } else if (isCompleteEvent(kind)) {
    events.push(...eventsFromComplete(event, acc.text.length > 0));
  }

  // Also check if usage was included on the event directly
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
  return events;
}

function withTap(req: ProviderCompleteRequest, transport: GeminiTransport): GeminiTransport {
  return {
    ...transport,
    fetch: tapFetch(req.tapGemini, transport.fetch),
  };
}

async function* streamComplete(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  if (!req.geminiBucket) {
    yield toErrorEvent('missing Gemini vault bucket for Interactions');
    return;
  }
  const res = await fetchGemini(
    INTERACTIONS_URL,
    { method: 'POST', body: JSON.stringify(toInteractionsBody(req)), signal: req.signal },
    req.geminiBucket,
    withTap(req, transport),
  );
  if (res.status !== HTTP_OK) {
    const errorBody = await res.text().catch(() => '');
    yield toErrorEvent(`Gemini HTTP ${String(res.status)}: ${errorBody}`);
    return;
  }
  const acc = { text: '' };
  const speech = Boolean(req.speech);
  for await (const payload of readSseRecords(res)) {
    req.tapGemini?.(payload);
    const events = foldPayload(payload, acc);
    for (const event of events) {
      yield normalizeSpeechMedia(event, speech);
    }
  }
  if (req.structured && acc.text) {
    const structured = tryStructured(acc.text);
    if (structured) {
      yield structured;
    }
  }
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

/** @internal Exported for direct unit testing only. */
export const _internals = {
  base64ToBytes,
  bytesToBase64,
  isRawPcmMime,
  normalizeSpeechMedia,
  eventType,
  isDeltaEvent,
  isCompleteEvent,
  foldDeltaPayload,
  foldPayload,
  withTap,
};
