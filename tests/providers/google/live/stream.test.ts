import { assertEquals, assertExists } from '@std/assert';
import type { ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import type { GeminiTransport } from '../../../../src/providers/google/keys.ts';
import { createGoogleLiveProvider } from '../../../../src/providers/google/live/stream.ts';
import { testInternals } from '../../../fixtures/testInternals.js';

const _internals = testInternals('google-live-stream');

Deno.test('createGoogleLiveProvider returns ModelProvider with complete function', () => {
  const transport: GeminiTransport = {
    vault: { freeA: 'mock-key-abc', freeB: undefined, freeC: undefined, paid: undefined },
  };
  const provider = createGoogleLiveProvider(transport);
  assertExists(provider);
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('_internals.readMessageData handles strings, ArrayBuffers, and Blobs', async () => {
  const str = await _internals.readMessageData('hello');
  assertEquals(str, 'hello');

  const buf = new TextEncoder().encode('buffer text').buffer;
  const fromBuf = await _internals.readMessageData(buf);
  assertEquals(fromBuf, 'buffer text');

  const blob = new Blob(['blob text']);
  const fromBlob = await _internals.readMessageData(blob);
  assertEquals(fromBlob, 'blob text');

  const fromNumber = await _internals.readMessageData(12345);
  assertEquals(fromNumber, '12345');
});

Deno.test('_internals.readGeminiLiveErrorMessage extracts error details', () => {
  assertEquals(_internals.readGeminiLiveErrorMessage({}), null);
  assertEquals(_internals.readGeminiLiveErrorMessage({ error: null }), null);
  assertEquals(
    _internals.readGeminiLiveErrorMessage({
      error: { message: 'Invalid payload', status: 'INVALID_ARGUMENT' },
    }),
    'INVALID_ARGUMENT: Invalid payload',
  );
  assertEquals(
    _internals.readGeminiLiveErrorMessage({
      error: { message: 'Quota exceeded' },
    }),
    'Quota exceeded',
  );
  assertEquals(
    _internals.readGeminiLiveErrorMessage({
      error: { status: 'UNKNOWN' },
    }),
    'Gemini returned an error during live session.',
  );
});

Deno.test('streamGeminiLive yields error when API key is missing', async () => {
  const transport: GeminiTransport = {
    vault: { freeA: undefined, freeB: undefined, freeC: undefined, paid: undefined },
  };
  const provider = createGoogleLiveProvider(transport);
  const req = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    geminiBucket: 'freeA',
  } as unknown as ProviderCompleteRequest;

  const events = [];
  for await (const ev of provider.complete(req)) {
    events.push(ev);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
});

Deno.test('streamGeminiLive handles pre-aborted signal gracefully', async () => {
  const transport: GeminiTransport = {
    vault: { freeA: 'valid-mock-key', freeB: undefined, freeC: undefined, paid: undefined },
  };
  const provider = createGoogleLiveProvider(transport);
  const controller = new AbortController();
  controller.abort();

  const req = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    geminiBucket: 'freeA',
    signal: controller.signal,
  } as unknown as ProviderCompleteRequest;

  const events = [];
  try {
    for await (const ev of provider.complete(req)) {
      events.push(ev);
    }
  } catch (err) {
    assertEquals((err as Error).name, 'AbortError');
  }
});

Deno.test('_internals.sendInitialPayloads sends history and input payloads over websocket', () => {
  const sent: string[] = [];
  const mockWs = {
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;

  const req = {
    history: [{ role: 'user', content: 'hello' }],
    input: [{ type: 'text', text: 'live input' }],
  } as unknown as ProviderCompleteRequest;

  _internals.sendInitialPayloads(mockWs, req);
  assertEquals(sent.length, 2);
  assertEquals(sent[0]?.includes('clientContent'), true);
  assertEquals(sent[1]?.includes('realtimeInput'), true);
});

Deno.test('_internals.createLiveQueue queues items and resolves async next', async () => {
  const queue = _internals.createLiveQueue();
  assertEquals(queue.isClosed(), false);

  queue.push({ type: 'event', events: [{ type: 'text', text: 'hi' }] });
  const item1 = await queue.next();
  assertEquals(item1?.type, 'event');

  const pendingNext = queue.next();
  queue.push({ type: 'done' });
  const item2 = await pendingNext;
  assertEquals(item2?.type, 'done');

  queue.close();
  assertEquals(queue.isClosed(), true);
  const itemAfterClose = await queue.next();
  assertEquals(itemAfterClose, undefined);
});
