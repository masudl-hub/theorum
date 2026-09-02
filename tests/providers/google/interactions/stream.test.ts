import '../../../fixtures/test-host.ts';
import '../../../fixtures/enable-test-internals.ts';
import { PUBLIC_UNAVAILABLE } from '../../../../src/guardrails/error.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../../../src/kernel/registry/resolve.ts';
import type { ProviderCompleteRequest, TurnEvent } from '../../../../src/kernel/types.ts';
import {
  camelToSnake,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import { createInteractionsProvider } from '../../../../src/providers/google/interactions/stream.ts';
import type { GeminiVault } from '../../../../src/providers/google/keys.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL } from '../../../../src/providers/google/urls.ts';
import { testInternals } from '../../../fixtures/testInternals.js';

const _internals = testInternals('google-interactions');

const vault: GeminiVault = {
  freeA: 'free-a-key',
  freeB: 'free-b-key',
  freeC: 'free-c-key',
  paid: 'paid-key',
};

const HTTP_OK = 200;
const HTTP_SERVER = 500;
const HTTP_QUOTA = 429;

function noWait(): Promise<void> {
  return Promise.resolve();
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function sseEvent(raw: string): unknown {
  return JSON.parse(raw);
}

function sseResponse(events: unknown[], status = HTTP_OK): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n');
  return new Response(`${payload}\ndata: [DONE]\n`, { status });
}

function headerApiKey(init?: RequestInit): string {
  return new Headers(init?.headers).get('x-goog-api-key') ?? '';
}

function fromChatProfile(): ProviderCompleteRequest {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'hi' },
  });
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  };
}

Deno.test('host profile Interactions body streams JSON schema and never ships geminiBucket', () => {
  const req = fromChatProfile();
  const body = toInteractionsBody(req);
  const format = body[camelToSnake('responseFormat')] as unknown[];
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.stream, true);
  assertEquals(Object.hasOwn(body, 'store'), false);
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('maxOutputTokens')], req.maxOutputTokens);
  assertEquals(Array.isArray(format), true);
  assertEquals(Object.hasOwn(body, camelToSnake('geminiBucket')), false);
  assertEquals(Object.hasOwn(body, 'geminiBucket'), false);
  assertEquals(Object.hasOwn(body, camelToSnake('previousInteractionId')), false);
});

Deno.test('Interactions body passes explicit store and previous interaction id', () => {
  const req = fromChatProfile();
  req.store = false;
  req.previousInteractionId = 'v1_prev';
  const body = toInteractionsBody(req);
  assertEquals(body.store, false);
  assertEquals(body[camelToSnake('previousInteractionId')], 'v1_prev');
});

Deno.test('chat voice audio wires as Interactions type audio', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      voice: [{ mimeType: 'audio/webm;codecs=opus', data: 'dGVzdA==' }],
    },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  });
  const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
  const parts = input[0]?.content ?? [];
  assertEquals(
    parts.some((part) => part.type === 'audio' && part[camelToSnake('mimeType')] === 'audio/webm'),
    true,
  );
});

Deno.test('Interactions body formats multi-turn history with text and parts', () => {
  const req = fromChatProfile();
  req.history = [
    { role: 'user', content: 'What is record care?' },
    { role: 'assistant', content: 'It is maintaining records.' },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'Check this image' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    },
  ];
  const body = toInteractionsBody(req);
  const input = body.input as Array<{ type: string; content: Array<Record<string, string>> }>;
  assertEquals(input.length, 4);
  assertEquals(input[0]?.type, 'user_input');
  assertEquals(input[0]?.content[0]?.text, 'What is record care?');
  assertEquals(input[1]?.type, 'model_output');
  assertEquals(input[1]?.content[0]?.text, 'It is maintaining records.');
  assertEquals(input[2]?.type, 'user_input');
  assertEquals(input[2]?.content[0]?.text, 'Check this image');
  assertEquals(input[2]?.content[1]?.mime_type, 'image/png');
  assertEquals(input[3]?.type, 'user_input');
  assertEquals(input[3]?.content[0]?.text, '<user_data>\nhi\n</user_data>');
});

Deno.test('JSON Schema property names stay camelCase inside response_format.schema', () => {
  const { generation } = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'html' } },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  });
  const format = body[camelToSnake('responseFormat')] as Array<Record<string, unknown>>;
  const schema = format[0]?.schema as Record<string, unknown>;
  assertEquals(Object.hasOwn(schema.properties as Record<string, unknown>, 'message'), true);
  assertEquals(Object.hasOwn(schema.properties as Record<string, unknown>, 'html'), true);
});

Deno.test('prompt-enforced schema omits JSON response_format', () => {
  const { generation } = resolveTurn({
    profile: 'selector',
    select: 'fast',
    input: { text: 'x' },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  });
  assertEquals(body[camelToSnake('responseFormat')], undefined);
});

Deno.test('pinned profile wires 3.5 minimal through theorum', () => {
  const { generation } = resolveTurn({
    profile: 'pinned',
    input: { text: 'x' },
  });
  assertEquals(generation.model, 'gemini35FlashLite');
  assertEquals(generation.thinking, 'low');
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: '',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  });
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('thinkingLevel')], 'low');
});

Deno.test('provider POSTs Interactions JSON when stream is false', async () => {
  let href = '';
  let postedStream: unknown;
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (url, init) => {
      href = String(url);
      postedStream = JSON.parse(String(init?.body ?? '{}')).stream;
      return Promise.resolve(
        Response.json({
          id: 'v1_batch',
          status: 'completed',
          steps: [
            {
              type: 'code_execution_call',
              id: 'code_call_1',
              arguments: { code: 'print(1)' },
            },
            {
              type: 'code_execution_result',
              call_id: 'code_call_1',
              result: '1\n',
            },
            {
              type: 'model_output',
              content: [{ type: 'text', text: 'One.' }],
            },
          ],
        }),
      );
    },
  });
  const events = await collect(provider.complete({ ...fromChatProfile(), stream: false }));
  assertEquals(href, INTERACTIONS_JSON_URL);
  assertEquals(postedStream, false);
  assertEquals(events.filter((e) => e.type === 'evidence').length, 2);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'One.'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('provider POSTs Interactions SSE on the resolved free key', async () => {
  const used: string[] = [];
  let href = '';
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (url, init) => {
      href = String(url);
      used.push(headerApiKey(init));
      return Promise.resolve(
        sseResponse([
          sseEvent('{"event_type":"content.delta","delta":{"type":"thought","text":"hmm"}}'),
          sseEvent(
            '{"event_type":"content.delta","delta":{"type":"text","text":"{\\"message\\":\\"ok\\"}"}}',
          ),
          sseEvent('{"event_type":"interaction.complete","interaction":{}}'),
        ]),
      );
    },
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(href, INTERACTIONS_URL);
  assertEquals(used, ['free-a-key']);
  assertEquals(events, [
    { type: 'thought', text: 'hmm' },
    { type: 'text', text: '{"message":"ok"}' },
    { type: 'structured', structured: { message: 'ok' } },
  ]);
});

Deno.test('provider emits Google grounding metadata as a grounding event', async () => {
  const groundingMetadata = {
    searchEntryPoint: { renderedContent: '<div>search</div>' },
    groundingChunks: [
      {
        maps: {
          title: 'Plant Shop',
          uri: 'https://maps.google.com/?cid=1',
          placeId: 'places/abc',
          text: '**Address:** 1 Fern St\n**Location:** 47.1, -122.2',
        },
      },
      {
        web: {
          title: 'Care source',
          uri: 'https://example.com/care',
        },
      },
    ],
  };
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          {
            event_type: 'interaction.completed',
            interaction: {
              id: 'v1_grounded',
              status: 'completed',
              groundingMetadata,
            },
          },
        ]),
      ),
  });
  const events = await collect(provider.complete(fromChatProfile()));
  const grounding = events.find((event) => event.type === 'grounding')?.grounding;
  assertEquals(grounding?.metadata, groundingMetadata);
  assertEquals(grounding?.chunks?.length, 2);
  assertEquals(grounding?.searchHtml, '<div>search</div>');
  assertEquals(grounding?.sources, [
    {
      type: 'maps',
      uri: 'https://maps.google.com/?cid=1',
      title: 'Plant Shop',
    },
    { type: 'web', uri: 'https://example.com/care', title: 'Care source' },
  ]);
});

Deno.test('provider overflows to paid only after 429 backoff', async () => {
  const used: string[] = [];
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: (_url, init) => {
      const key = headerApiKey(init);
      used.push(key);
      if (key !== 'paid-key') {
        return Promise.resolve(new Response('no', { status: HTTP_QUOTA }));
      }
      return Promise.resolve(
        sseResponse([
          sseEvent('{"event_type":"content.delta","delta":{"type":"text","text":"hi"}}'),
        ]),
      );
    },
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key', 'paid-key']);
  assertEquals(events[0], { type: 'text', text: 'hi' });
});

Deno.test('non-OK Gemini response becomes an error event', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(new Response('nope', { status: HTTP_SERVER })),
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(events, [
    {
      type: 'error',
      error: PUBLIC_UNAVAILABLE,
      errorInternal: 'Gemini HTTP 500: nope',
    },
  ]);
});

Deno.test('thrown fetch errors become upstream failed', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.reject(new TypeError('fetch failed: dns')),
  });
  const events = await collect(provider.complete(fromChatProfile()));
  assertEquals(events, [
    {
      type: 'error',
      error: PUBLIC_UNAVAILABLE,
      errorInternal: 'fetch failed: dns',
    },
  ]);
});

Deno.test('image delta yields media', async () => {
  const { generation } = resolveTurn({
    profile: 'image',
    input: { text: 'fox' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          sseEvent(
            '{"event_type":"content.delta","delta":{"type":"image","mime_type":"image/png","data":"abc"}}',
          ),
        ]),
      ),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      geminiBucket: generation.geminiBucket,
    }),
  );
  assertEquals(events, [
    {
      type: 'media',
      media: { mimeType: 'image/png', data: 'abc' },
    },
  ]);
});

Deno.test('interaction complete yields output_image media', async () => {
  const { generation } = resolveTurn({
    profile: 'image',
    input: { text: 'fox' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          sseEvent(
            '{"event_type":"interaction.complete","interaction":{"output_image":{"mime_type":"image/png","data":"xyz"}}}',
          ),
        ]),
      ),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      geminiBucket: generation.geminiBucket,
    }),
  );
  assertEquals(events, [
    {
      type: 'media',
      media: { mimeType: 'image/png', data: 'xyz' },
    },
  ]);
});

Deno.test('interaction complete yields outputs image media', async () => {
  const { generation } = resolveTurn({
    profile: 'image',
    input: { text: 'fox' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          sseEvent(
            '{"event_type":"interaction.complete","interaction":{"outputs":[{"type":"image","mime_type":"image/png","data":"out"}]}}',
          ),
        ]),
      ),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      geminiBucket: generation.geminiBucket,
    }),
  );
  assertEquals(events, [
    {
      type: 'media',
      media: { mimeType: 'image/png', data: 'out' },
    },
  ]);
});

Deno.test('provider handles null body, direct event usage/grounding, and structured resolution', async () => {
  // 1. Null response body
  const nullBodyProvider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
  });
  const { generation } = resolveTurn({ profile: 'pinned', input: { text: 'x' } });
  const nullEvents = await collect(
    nullBodyProvider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      geminiBucket: generation.geminiBucket,
    }),
  );
  assertEquals(nullEvents.length, 1);
  assertEquals(nullEvents[0]?.type, 'error');

  // 2. Direct event usage & grounding metadata + structured return
  const rawEvents = [
    {
      event_type: 'content.delta',
      delta: { type: 'text', text: '{"message": "success"}' },
      usage_metadata: { prompt_token_count: 10, candidates_token_count: 20 },
      grounding_metadata: { grounding_chunks: [{ web: { uri: 'https://example.com' } }] },
    },
  ];
  const structProvider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(sseResponse(rawEvents)),
  });
  const { generation: chatGen } = resolveTurn({ profile: 'chat', input: { text: 'x' } });
  const resultEvents = await collect(
    structProvider.complete({
      model: chatGen.model,
      apiId: chatGen.apiId,
      thinking: chatGen.thinking,
      summaries: chatGen.summaries,
      maxOutputTokens: chatGen.maxOutputTokens,
      temperature: chatGen.temperature,
      builtins: chatGen.builtins,
      system: '',
      input: chatGen.input,
      structured: chatGen.structured,
      image: chatGen.image,
      geminiBucket: chatGen.geminiBucket,
    }),
  );

  const textEv = resultEvents.find((e) => e.type === 'text');
  const tokensEv = resultEvents.find((e) => e.type === 'tokens');
  const structEv = resultEvents.find((e) => e.type === 'structured');

  assertEquals(textEv !== undefined, true);
  assertEquals(tokensEv !== undefined, true);
  assertEquals(structEv !== undefined, true);
});

Deno.test('_internals.base64ToBytes decodes known base64 values', () => {
  assertEquals(_internals.base64ToBytes('aGVsbG8='), new TextEncoder().encode('hello'));
  assertEquals(_internals.base64ToBytes(''), new Uint8Array());
});

Deno.test('_internals.bytesToBase64 encodes known byte values', () => {
  assertEquals(_internals.bytesToBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
  assertEquals(_internals.bytesToBase64(new Uint8Array()), '');
});

Deno.test('base64 helpers roundtrip arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = _internals.bytesToBase64(bytes);
  assertEquals(_internals.base64ToBytes(encoded), bytes);
});

Deno.test('_internals.isRawPcmMime recognizes raw PCM mime types case-insensitively', () => {
  assertEquals(_internals.isRawPcmMime('audio/pcm'), true);
  assertEquals(_internals.isRawPcmMime('audio/l16'), true);
  assertEquals(_internals.isRawPcmMime('audio/raw'), true);
  assertEquals(_internals.isRawPcmMime('AUDIO/PCM'), true);
});

Deno.test('_internals.isRawPcmMime rejects non-PCM mime types', () => {
  assertEquals(_internals.isRawPcmMime('audio/wav'), false);
  assertEquals(_internals.isRawPcmMime('audio/mpeg'), false);
});

Deno.test('_internals.normalizeSpeechMedia returns event unchanged when speech is false', () => {
  const event: TurnEvent = {
    type: 'media',
    media: { mimeType: 'audio/pcm', data: 'abc' },
  };
  assertEquals(_internals.normalizeSpeechMedia(event, false), event);
});

Deno.test('_internals.normalizeSpeechMedia returns non-media events unchanged', () => {
  const event: TurnEvent = { type: 'text', text: 'hi' };
  assertEquals(_internals.normalizeSpeechMedia(event, true), event);
});

Deno.test('_internals.normalizeSpeechMedia returns non-PCM media events unchanged', () => {
  const event: TurnEvent = {
    type: 'media',
    media: { mimeType: 'audio/wav', data: 'abc' },
  };
  assertEquals(_internals.normalizeSpeechMedia(event, true), event);
});

Deno.test('_internals.normalizeSpeechMedia wraps raw PCM media as WAV when speech is true', () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const event: TurnEvent = {
    type: 'media',
    media: { mimeType: 'audio/pcm', data: _internals.bytesToBase64(pcm) },
  };
  const result = _internals.normalizeSpeechMedia(event, true);
  assertEquals(result.type, 'media');
  const media = result.type === 'media' ? result.media : undefined;
  assertEquals(media?.mimeType, 'audio/wav');
  const bytes = _internals.base64ToBytes(media?.data ?? '');
  assertEquals(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assertEquals(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
});

Deno.test('_internals.readData and readMime extract part media properties', () => {
  assertEquals(_internals.readData({ data: 'abc' }), 'abc');
  assertEquals(_internals.readData({ data: '' }), undefined);
  assertEquals(_internals.readData({}), undefined);

  assertEquals(_internals.readMime({ mime_type: 'image/png' }), 'image/png');
  assertEquals(_internals.readMime({ mimeType: 'audio/wav' }), 'audio/wav');
  assertEquals(_internals.readMime({}), undefined);
});

Deno.test('_internals.yieldMediaChunk yields media events for binary chunks', () => {
  const chunks = Array.from(
    _internals.yieldMediaChunk({ data: 'aGVsbG8=', mime_type: 'image/png' }),
  );
  assertEquals(chunks.length, 1);
  assertEquals((chunks[0] as { type: string }).type, 'media');

  const pcmBytes = _internals.bytesToBase64(new Uint8Array([0, 0, 0, 0]));
  const pcmChunks = Array.from(
    _internals.yieldMediaChunk({ data: pcmBytes, mime_type: 'audio/pcm' }),
  );
  assertEquals(pcmChunks.length, 1);
  assertEquals((pcmChunks[0] as { media?: { mimeType?: string } })?.media?.mimeType, 'audio/wav');

  const empty = Array.from(_internals.yieldMediaChunk({}));
  assertEquals(empty.length, 0);
});

Deno.test('_internals.scanMediaParts scans nested content arrays', () => {
  const parts = [
    { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
    { type: 'text', text: 'ignore text' },
    null,
  ];
  const events = Array.from(_internals.scanMediaParts(parts));
  assertEquals(events.length, 1);
  assertEquals((events[0] as { type: string }).type, 'media');

  const notArray = Array.from(_internals.scanMediaParts('invalid'));
  assertEquals(notArray.length, 0);
});

Deno.test('_internals.eventType prefers event_type, falls back to type, then empty string', () => {
  assertEquals(
    _internals.eventType({ event_type: 'content.delta', type: 'ignored' }),
    'content.delta',
  );
  assertEquals(_internals.eventType({ type: 'interaction.complete' }), 'interaction.complete');
  assertEquals(_internals.eventType({}), '');
});

Deno.test('_internals.isDeltaEvent matches delta kinds only', () => {
  assertEquals(_internals.isDeltaEvent('content.delta'), true);
  assertEquals(_internals.isDeltaEvent('step.delta'), true);
  assertEquals(_internals.isDeltaEvent('interaction.complete'), false);
  assertEquals(_internals.isDeltaEvent('other'), false);
});

Deno.test('_internals.isCompleteEvent matches interaction completion kinds', () => {
  assertEquals(_internals.isCompleteEvent('interaction.complete'), true);
  assertEquals(_internals.isCompleteEvent('interaction.completed'), true);
  assertEquals(_internals.isCompleteEvent('interaction.created'), false);
  assertEquals(_internals.isCompleteEvent('interaction.status_update'), false);
  assertEquals(_internals.isCompleteEvent('content.delta'), false);
});

Deno.test('_internals.foldArgumentsDelta appends streamed argument chunks', () => {
  const fold = _internals.newStreamFold();
  _internals.foldArgumentsDelta({ arguments: '{"q":' }, 0, fold);
  _internals.foldArgumentsDelta({ arguments: '"query"}' }, 0, fold);
  assertEquals(fold.functionCalls.get(0)?.arguments, '{"q":"query"}');
});

Deno.test('_internals.foldFunctionCallDelta parses function calls and deduplicates', () => {
  const fold = _internals.newStreamFold();
  const events1 = _internals.foldFunctionCallDelta(
    { id: 'call_1', name: 'search', arguments: '{"q":"test"}' },
    fold,
  );
  assertEquals(events1.length, 1);
  assertEquals(events1[0]?.type, 'tool');
  assertEquals(events1[0]?.tool?.id, 'call_1');
  assertEquals(events1[0]?.tool?.name, 'search');
  assertEquals(events1[0]?.tool?.arguments, { q: 'test' });

  // Deduplication check
  const events2 = _internals.foldFunctionCallDelta(
    { id: 'call_1', name: 'search', arguments: { q: 'test' } },
    fold,
  );
  assertEquals(events2.length, 0);
});

Deno.test('_internals.foldDeltaPayload accumulates text into the fold', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldDeltaPayload({ delta: { type: 'text', text: 'hello' } }, fold);
  assertEquals(fold.text, 'hello');
  assertEquals(events, [{ type: 'text', text: 'hello' }]);

  const more = _internals.foldDeltaPayload({ delta: { type: 'text', text: ' world' } }, fold);
  assertEquals(fold.text, 'hello world');
  assertEquals(more, [{ type: 'text', text: ' world' }]);
});

Deno.test('_internals.foldPayload folds a delta event and accumulates text', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    { event_type: 'content.delta', delta: { type: 'text', text: 'hi' } },
    fold,
  );
  assertEquals(fold.text, 'hi');
  assertEquals(events, [{ type: 'text', text: 'hi' }]);
});

Deno.test('_internals.foldPayload folds a complete event', () => {
  const fold = _internals.newStreamFold();
  fold.text = 'already streamed';
  const events = _internals.foldPayload(
    { event_type: 'interaction.complete', interaction: {} },
    fold,
  );
  assertEquals(Array.isArray(events), true);
});

Deno.test('_internals.foldPayload extracts direct usage metadata not covered by delta/complete events', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'unknown.kind',
      usage_metadata: { prompt_token_count: 3, candidates_token_count: 7 },
    },
    fold,
  );
  const tokens = events.find((e: { type: string }) => e.type === 'tokens');
  assertEquals(tokens !== undefined, true);
});

Deno.test('_internals.foldPayload extracts direct grounding metadata not covered by delta/complete events', () => {
  const fold = _internals.newStreamFold();
  const groundingMetadata = { groundingChunks: [{ web: { uri: 'https://example.com' } }] };
  const events = _internals.foldPayload(
    { event_type: 'unknown.kind', grounding_metadata: groundingMetadata },
    fold,
  );
  const grounding = events.find((e: { type: string }) => e.type === 'grounding');
  assertEquals(grounding !== undefined, true);
});

Deno.test('_internals.foldPayload emits grounding + evidence for Interactions google_search_result', () => {
  const fold = _internals.newStreamFold();
  const chipHtml = '<div class="chip">photosynthesis</div>';
  const events = _internals.foldPayload(
    {
      event_type: 'step.delta',
      delta: {
        type: 'google_search_result',
        result: [{ search_suggestions: chipHtml }],
      },
    },
    fold,
  );
  const grounding = events.find((e: { type: string }) => e.type === 'grounding') as {
    grounding?: { searchHtml?: string };
  };
  const evidence = events.find((e: { type: string }) => e.type === 'evidence') as {
    evidence?: { provider?: string; raw?: { type?: string } };
  };
  assertEquals(grounding?.grounding?.searchHtml, chipHtml);
  assertEquals(evidence?.evidence?.provider, 'google');
  assertEquals(evidence?.evidence?.raw?.type, 'google_search_result');
});

Deno.test('_internals.foldPayload emits evidence for code_execution_call deltas', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'step.delta',
      delta: {
        type: 'code_execution_call',
        arguments: { code: 'print(1)' },
      },
    },
    fold,
  );
  const evidence = events.find((e: { type: string }) => e.type === 'evidence') as {
    evidence?: { raw?: { type?: string }; kind?: string; code?: string };
  };
  assertEquals(evidence?.evidence?.raw?.type, 'code_execution_call');
  assertEquals(evidence?.evidence?.kind, 'code_execution_call');
  assertEquals(evidence?.evidence?.code, 'print(1)');
});

Deno.test('_internals.foldPayload streams code exec then skips duplicate steps on complete', () => {
  const fold = _internals.newStreamFold();
  _internals.foldPayload(
    {
      event_type: 'step.start',
      index: 0,
      step: {
        type: 'code_execution_call',
        id: 'code_call_1',
        arguments: { code: 'print(2)' },
      },
    },
    fold,
  );
  _internals.foldPayload(
    {
      event_type: 'step.delta',
      index: 1,
      delta: {
        type: 'code_execution_result',
        call_id: 'code_call_1',
        result: '2\n',
      },
    },
    fold,
  );
  const completed = _internals.foldPayload(
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'v1_code',
        status: 'completed',
        steps: [
          {
            type: 'code_execution_call',
            id: 'code_call_1',
            arguments: { code: 'print(2)' },
          },
          {
            type: 'code_execution_result',
            call_id: 'code_call_1',
            result: '2\n',
          },
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'done' }],
          },
        ],
      },
    },
    fold,
  );
  const evidence = completed.filter((e: { type: string }) => e.type === 'evidence');
  assertEquals(evidence.length, 0);
  assertEquals(
    completed.some((e: { type: string; text?: string }) => e.type === 'text' && e.text === 'done'),
    true,
  );
});

Deno.test('_internals.foldPayload replays batched steps when nothing streamed', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'v1_batch',
        status: 'completed',
        steps: [
          {
            type: 'code_execution_call',
            id: 'code_call_9',
            arguments: { code: 'print(3)' },
          },
          {
            type: 'code_execution_result',
            call_id: 'code_call_9',
            result: '3\n',
          },
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'Three.' },
              { type: 'image', mime_type: 'image/png', data: 'img' },
            ],
          },
        ],
      },
    },
    fold,
  );
  assertEquals(events.filter((e: { type: string }) => e.type === 'evidence').length, 2);
  assertEquals(
    events.some((e: { type: string }) => e.type === 'media'),
    true,
  );
  assertEquals(
    events.some((e: { type: string; text?: string }) => e.type === 'text' && e.text === 'Three.'),
    true,
  );
});

Deno.test('_internals.foldPayload emits code exec on step.stop when no delta arrived', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'step.stop',
      index: 0,
      step: {
        type: 'code_execution_result',
        call_id: 'code_call_stop',
        result: 'ok\n',
        is_error: false,
      },
    },
    fold,
  );
  const evidence = events.find((e: { type: string }) => e.type === 'evidence') as {
    evidence?: { kind?: string; result?: string; isError?: boolean };
  };
  assertEquals(evidence?.evidence?.kind, 'code_execution_result');
  assertEquals(evidence?.evidence?.result, 'ok\n');
  assertEquals(evidence?.evidence?.isError, false);
});

Deno.test('_internals.foldPayload emits tools on interaction.status_update requires_action', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'interaction.status_update',
      interaction: {
        id: 'v1_status',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'call_status',
            name: 'lookup_order',
            arguments: { orderId: '7' },
          },
        ],
      },
    },
    fold,
  );
  const tool = events.find((e: { type: string }) => e.type === 'tool') as {
    tool?: { name?: string; id?: string };
  };
  assertEquals(tool?.tool?.name, 'lookup_order');
  assertEquals(tool?.tool?.id, 'call_status');
  assertEquals(
    events.some((e: { type: string }) => e.type === 'done'),
    false,
  );
});

Deno.test('_internals.foldPayload emits tool events when interaction requires_action', () => {
  const fold = _internals.newStreamFold();
  const events = _internals.foldPayload(
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'v1_tool',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'call_abc',
            name: 'lookup_order',
            arguments: { orderId: '42' },
          },
        ],
      },
    },
    fold,
  );
  const tool = events.find((e: { type: string }) => e.type === 'tool') as {
    tool?: { name?: string; arguments?: Record<string, unknown>; id?: string };
  };
  assertEquals(tool?.tool?.name, 'lookup_order');
  assertEquals(tool?.tool?.id, 'call_abc');
  assertEquals(tool?.tool?.arguments, { orderId: '42' });
});

Deno.test('_internals.foldStepStart ignores empty steps and seeds function_call', () => {
  const fold = _internals.newStreamFold();
  assertEquals(_internals.foldStepStart({ event_type: 'step.start' }, fold), []);
  assertEquals(
    _internals.foldStepStart(
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      fold,
    ),
    [],
  );
  assertEquals(
    _internals.foldStepStart(
      {
        event_type: 'step.start',
        index: 1,
        step: { type: 'function_call', id: 'call_1', name: 'lookup_order' },
      },
      fold,
    ),
    [],
  );
  assertEquals(
    _internals.foldStepStart(
      { event_type: 'step.start', index: 2, step: { type: 'code_execution_call' } },
      fold,
    ),
    [],
  );
  const started = _internals.foldStepStart(
    {
      event_type: 'step.start',
      index: 3,
      step: { type: 'code_execution_call', arguments: 'print(1)' },
    },
    fold,
  );
  assertEquals(started[0]?.evidence?.code, 'print(1)');
});

Deno.test('foldPayload emits tool when function_call arrives on step.start with object arguments', () => {
  const fold = _internals.newStreamFold();
  const started = _internals.foldPayload(
    {
      event_type: 'step.start',
      index: 1,
      step: { id: 'call_live', type: 'function_call', name: 'stub_tool', arguments: {} },
    },
    fold,
  );
  const stopped = _internals.foldPayload({ event_type: 'step.stop', index: 1 }, fold);
  const completed = _internals.foldPayload(
    {
      event_type: 'interaction.completed',
      interaction: { id: 'v1_live', status: 'requires_action' },
    },
    fold,
  );
  const tools = [...started, ...stopped, ...completed].filter((e) => e.type === 'tool');
  assertEquals(tools.length, 1);
  assertEquals(tools[0]?.tool?.name, 'stub_tool');
  assertEquals(tools[0]?.tool?.id, 'call_live');
});

Deno.test('_internals.foldDeltaPayload accumulates function arguments and media', () => {
  const fold = _internals.newStreamFold();
  assertEquals(_internals.foldDeltaPayload({ event_type: 'step.delta' }, fold), []);
  _internals.foldDeltaPayload(
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"a":' } },
    fold,
  );
  _internals.foldDeltaPayload(
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments', arguments: '1}' } },
    fold,
  );
  const media = _internals.foldDeltaPayload(
    {
      event_type: 'step.delta',
      delta: { type: 'image', mime_type: 'image/png', data: 'img' },
    },
    fold,
  );
  assertEquals(media[0]?.type, 'media');
});

Deno.test('_internals.withTap wraps the transport fetch without mutating other fields', () => {
  const calls: string[] = [];
  const transport = {
    vault,
    wait: noWait,
    fetch: (url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response('ok'));
    },
  };
  const req = fromChatProfile();
  const wrapped = _internals.withTap(req, transport);
  assertEquals(wrapped.vault, vault);
  assertEquals(wrapped.wait, noWait);
  assertEquals(typeof wrapped.fetch, 'function');
});
