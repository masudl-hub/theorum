import { assertEquals, assertExists } from '@std/assert';
import type { GeminiTransport } from '../../../../src/providers/google/keys.ts';
import {
  createGoogleLiveProvider,
  createLiveQueue,
  readGeminiLiveErrorMessage,
  readMessageData,
  sendInitialPayloads,
} from '../../../../src/providers/google/live/stream.ts';
import { stubCompleteRequest } from '../../../fixtures/provider-request.ts';

Deno.test('createGoogleLiveProvider returns ModelProvider with complete function', () => {
  const transport: GeminiTransport = {
    vault: { freeA: 'mock-key-abc', freeB: undefined, freeC: undefined, paid: undefined },
  };
  const provider = createGoogleLiveProvider(transport);
  assertExists(provider);
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('readMessageData handles strings, ArrayBuffers, and Blobs', async () => {
  const str = await readMessageData('hello');
  assertEquals(str, 'hello');

  const buf = new TextEncoder().encode('buffer text').buffer;
  const fromBuf = await readMessageData(buf);
  assertEquals(fromBuf, 'buffer text');

  const blob = new Blob(['blob text']);
  const fromBlob = await readMessageData(blob);
  assertEquals(fromBlob, 'blob text');

  const fromNumber = await readMessageData(12345);
  assertEquals(fromNumber, '12345');
});

Deno.test('readGeminiLiveErrorMessage extracts error details', () => {
  assertEquals(readGeminiLiveErrorMessage({}), null);
  assertEquals(readGeminiLiveErrorMessage({ error: null }), null);
  assertEquals(
    readGeminiLiveErrorMessage({
      error: { message: 'Invalid payload', status: 'INVALID_ARGUMENT' },
    }),
    'INVALID_ARGUMENT: Invalid payload',
  );
  assertEquals(
    readGeminiLiveErrorMessage({
      error: { message: 'Quota exceeded' },
    }),
    'Quota exceeded',
  );
  assertEquals(
    readGeminiLiveErrorMessage({
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
  const req = stubCompleteRequest({
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    geminiBucket: 'freeA',
  });

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

  const req = stubCompleteRequest({
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    geminiBucket: 'freeA',
    signal: controller.signal,
  });

  const events = [];
  try {
    for await (const ev of provider.complete(req)) {
      events.push(ev);
    }
  } catch (err) {
    assertEquals((err as Error).name, 'AbortError');
  }
});

Deno.test('sendInitialPayloads sends history and input payloads over websocket', () => {
  const sent: string[] = [];
  const mockWs = {
    send: (payload: string) => sent.push(payload),
  };

  const req = stubCompleteRequest({
    history: [{ role: 'user', content: 'hello' }],
    input: [{ type: 'text', text: 'live input' }],
  });

  sendInitialPayloads(mockWs, req);
  assertEquals(sent.length, 2);
  assertEquals(sent[0]?.includes('clientContent'), true);
  assertEquals(sent[1]?.includes('realtimeInput'), true);
});

Deno.test('createLiveQueue queues items and resolves async next', async () => {
  const queue = createLiveQueue();
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
