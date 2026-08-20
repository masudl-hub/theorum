import { publicError, TheorumError } from '../guardrails/error.ts';
import { fetchGemini, type GeminiTransport } from '../guardrails/keys.ts';
import {
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  tryStructured,
} from '../kernel/engine/delta.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../kernel/types.ts';
import { tapFetch } from './google-tap.ts';
import { toInteractionsBody } from './interactions.ts';
import { INTERACTIONS_URL, takeSsePayloads } from './sse.ts';

const HTTP_OK = 200;

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

function foldPayload(event: Record<string, unknown>, acc: { text: string }): TurnEvent[] {
  const kind = eventType(event);
  const events: TurnEvent[] = [];
  if (kind === 'content.delta' || kind === 'step.delta') {
    const deltaEvents = eventsFromDelta(event.delta);
    for (const item of deltaEvents) {
      if (item.type === 'text' && item.text) {
        acc.text += item.text;
      }
      events.push(item);
    }
  }
  if (
    kind === 'interaction.complete' ||
    kind === 'interaction.completed' ||
    kind.startsWith('interaction.')
  ) {
    const completeEvents = eventsFromComplete(event, acc.text.length > 0);
    events.push(...completeEvents);
  }

  // Also check if usage was included on the event directly
  if (!events.some((e) => e.type === 'tokens')) {
    const tokenEvent = extractTokenEvent(event);
    if (tokenEvent) {
      events.push(tokenEvent);
    }
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
  const res = await fetchGemini(
    INTERACTIONS_URL,
    { method: 'POST', body: JSON.stringify(toInteractionsBody(req)) },
    req.geminiBucket,
    withTap(req, transport),
  );
  if (res.status !== HTTP_OK) {
    yield { type: 'error', error: publicError(`Gemini HTTP ${String(res.status)}`) };
    return;
  }
  const acc = { text: '' };
  for await (const payload of readSseRecords(res)) {
    req.tapGemini?.(payload);
    const events = foldPayload(payload, acc);
    for (const event of events) {
      yield event;
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
    yield { type: 'error', error: publicError(err) };
  }
}

function createInteractionsProvider(transport: GeminiTransport): ModelProvider {
  return {
    complete: (req) => streamGuarded(req, transport),
  };
}

export { createInteractionsProvider };
