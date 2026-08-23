import { assertEquals } from '@std/assert';
import { PUBLIC_GENERIC, PUBLIC_UNAVAILABLE } from '../../src/guardrails/error.ts';
import type { ProviderCompleteRequest } from '../../src/kernel/types.ts';
import {
  createOpenRouterTtsProvider,
  streamOpenRouterTts,
  wrapPcmAsWav,
} from '../../src/providers/tts.ts';

function createMockTtsRequest(text: string): ProviderCompleteRequest {
  return {
    model: 'gemini31FlashTts',
    thinking: 'minimal',
    summaries: 'none',
    maxOutputTokens: 2048,
    temperature: 0.2,
    builtins: [],
    system: '',
    input: [{ type: 'text', text }],
    structured: null,
    image: null,
    geminiBucket: 'freeA',
  };
}

Deno.test('wrapPcmAsWav creates valid 44-byte RIFF/WAVE header', () => {
  const pcm = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const wav = wrapPcmAsWav(pcm, 24000);

  assertEquals(wav.length, 44 + pcm.length);
  const view = new DataView(wav.buffer);

  // Check 'RIFF'
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  assertEquals(riff, 'RIFF');

  // Check 'WAVE'
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  assertEquals(wave, 'WAVE');

  // Check 'fmt '
  const fmt = String.fromCharCode(
    view.getUint8(12),
    view.getUint8(13),
    view.getUint8(14),
    view.getUint8(15),
  );
  assertEquals(fmt, 'fmt ');

  // Format 1 (PCM), Channels 1, Sample Rate 24000, Bits 16
  assertEquals(view.getUint16(20, true), 1);
  assertEquals(view.getUint16(22, true), 1);
  assertEquals(view.getUint32(24, true), 24000);
  assertEquals(view.getUint16(34, true), 16);

  // Check 'data'
  const dataTag = String.fromCharCode(
    view.getUint8(36),
    view.getUint8(37),
    view.getUint8(38),
    view.getUint8(39),
  );
  assertEquals(dataTag, 'data');
  assertEquals(view.getUint32(40, true), pcm.length);
});

Deno.test('streamOpenRouterTts yields error when apiKey is missing', async () => {
  const req = createMockTtsRequest('Hello world');
  const events = [];
  for await (const event of streamOpenRouterTts(req, { apiKey: '' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamOpenRouterTts yields error on empty input text', async () => {
  const req = createMockTtsRequest('');
  const events = [];
  for await (const event of streamOpenRouterTts(req, { apiKey: 'test-key' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamOpenRouterTts handles HTTP error from OpenRouter', async () => {
  const req = createMockTtsRequest('Hello world');
  const mockFetch: typeof fetch = () => Promise.resolve(new Response('Forbidden', { status: 403 }));

  const events = [];
  for await (const event of streamOpenRouterTts(req, { apiKey: 'test-key', fetch: mockFetch })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_UNAVAILABLE);
});

Deno.test('streamOpenRouterTts yields error when response is empty', async () => {
  const req = createMockTtsRequest('Hello world');
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(new Uint8Array([]), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );

  const events = [];
  for await (const event of streamOpenRouterTts(req, { apiKey: 'test-key', fetch: mockFetch })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamOpenRouterTts yields media, tokens, and done on successful synthesis via OpenRouter', async () => {
  const req = createMockTtsRequest('Hello, welcome to the demo!');
  const mockPcmBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

    return Promise.resolve(
      new Response(mockPcmBytes, {
        status: 200,
        headers: {
          'Content-Type': 'audio/pcm',
          'X-Generation-Id': 'gen-12345',
        },
      }),
    );
  };

  const provider = createOpenRouterTtsProvider({
    apiKey: 'mock-openrouter-key',
    voiceName: 'Orus',
    fetch: mockFetch,
  });

  const events = [];
  for await (const event of provider.complete(req)) {
    events.push(event);
  }

  assertEquals(capturedUrl, 'https://openrouter.ai/api/v1/audio/speech');
  assertEquals(capturedHeaders.Authorization, 'Bearer mock-openrouter-key');
  assertEquals(capturedBody.model, 'google/gemini-3.1-flash-tts-preview');
  assertEquals(capturedBody.input, 'Hello, welcome to the demo!');
  assertEquals(capturedBody.voice, 'Orus');
  assertEquals(capturedBody.response_format, 'pcm');

  assertEquals(events.length, 3);
  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/wav');
  assertEquals(typeof mediaEvent.media.data, 'string');

  assertEquals(events[1]?.type, 'tokens');
  const tokenEvent = events[1] as { tokens: { input: number; output: number; total: number } };
  assertEquals(tokenEvent.tokens.input > 0, true);
  assertEquals(tokenEvent.tokens.output > 0, true);

  assertEquals(events[2]?.type, 'done');
});

Deno.test('streamOpenRouterTts respects profile voice and response_format mp3', async () => {
  const req: ProviderCompleteRequest = {
    ...createMockTtsRequest('Testing MP3 output'),
    voice: {
      voice: 'Kore',
      responseFormat: 'mp3',
    },
  };
  const mockMp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]); // MP3 frame header start

  let capturedBody: Record<string, unknown> = {};
  const mockFetch: typeof fetch = (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      new Response(mockMp3Bytes, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
        },
      }),
    );
  };

  const provider = createOpenRouterTtsProvider({
    apiKey: 'mock-key',
    siteUrl: 'https://theorum.dev',
    siteName: 'Theorum Test',
    fetch: mockFetch,
  });

  const events = [];
  for await (const event of provider.complete(req)) {
    events.push(event);
  }

  assertEquals(capturedBody.voice, 'Kore');
  assertEquals(capturedBody.response_format, 'mp3');
  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/mpeg');
  assertEquals(mediaEvent.media.data, btoa(String.fromCharCode(...mockMp3Bytes)));
});
