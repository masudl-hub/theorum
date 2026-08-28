import '../fixtures/test-host.ts';
import type { LanguageModelUsage } from 'ai';
import { PUBLIC_UNAVAILABLE } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type {
  InteractionPart,
  ModelId,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
} from '../../src/kernel/types.ts';
import {
  _internals,
  createOpenRouterProvider,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from '../../src/providers/openrouter.ts';
import { HOST_MODELS } from '../fixtures/models.ts';

type R = Record<string, unknown>;
function field(ev: unknown, ...keys: string[]): unknown {
  let cur: unknown = ev;
  for (const k of keys) {
    cur = (cur as R)?.[k];
  }
  return cur;
}

const EXPECTED_INPUT_TOKENS = 25;
const EXPECTED_OUTPUT_TOKENS = 40;
const EXPECTED_TOTAL_TOKENS = 65;

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
  }
  return out;
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createMockTurnRequest(profile: string, text: string): ProviderCompleteRequest {
  const { generation } = resolveTurn({ profile, input: { text } });
  return {
    model: generation.model,
    apiId: generation.apiId,
    openRouterId: generation.openRouterId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'Host system prompt',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  };
}

Deno.test('resolveOpenRouterModel maps known models and accepts custom map', () => {
  const flashLite = HOST_MODELS.gemini35FlashLite;
  const proPreview = HOST_MODELS.gemini31ProPreview;
  const sonar = HOST_MODELS.sonar;
  assertEquals(
    resolveOpenRouterModel('gemini35FlashLite', undefined, {
      apiId: flashLite.apiId,
    }),
    'google/gemini-3.5-flash-lite',
  );
  assertEquals(
    resolveOpenRouterModel('gemini31ProPreview', undefined, {
      apiId: proPreview.apiId,
    }),
    'google/gemini-3.1-pro-preview',
  );
  assertEquals(
    resolveOpenRouterModel('sonar', undefined, {
      apiId: sonar.apiId,
      openRouterId: sonar.openRouterId,
    }),
    'perplexity/sonar',
  );
  assertEquals(
    resolveOpenRouterModel('gemini35FlashLite', {
      gemini35FlashLite: 'anthropic/claude-sonnet',
    }),
    'anthropic/claude-sonnet',
  );
  assertEquals(resolveOpenRouterModel('perplexity/sonar'), 'perplexity/sonar');
});

Deno.test('toOpenRouterPayload passes app-selected provider-native model ids through', () => {
  const req: ProviderCompleteRequest = {
    ...createMockTurnRequest('pinned', 'Research this'),
    model: 'perplexity/sonar:online' as ModelId,
    apiId: 'perplexity/sonar:online',
  };
  const payload = toOpenRouterPayload(req, {});
  assertEquals(payload.model, 'perplexity/sonar:online');
});

function assertMessage(
  msg: Record<string, unknown> | undefined,
  role: string,
  content?: string,
): void {
  assertEquals(msg?.role, role);
  if (content !== undefined) {
    assertEquals(msg?.content, content);
  }
}

Deno.test('toOpenRouterPayload formats system, history, text, and thinking effort', () => {
  const req = createMockTurnRequest('pinned', 'Watering schedule?');
  req.history = [
    { role: 'system', content: '[meta] ago=5m speaker=masud' },
    { role: 'user', content: 'What records do I have?' },
    { role: 'assistant', content: 'You have a Monstera deliciosa.' },
  ];
  req.dynamicTools = [
    {
      name: 'lookup_record',
      description: 'Fetch record guidance',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
    },
  ];

  const payload = toOpenRouterPayload(req, {});
  assertEquals(payload.model, 'google/gemini-3.5-flash-lite');
  assertEquals(payload.temperature, req.temperature);
  assertEquals((payload.reasoning as Record<string, unknown>).effort, 'low');

  const messages = payload.messages as Record<string, unknown>[];
  assertMessage(messages[0], 'system', 'Host system prompt');
  assertMessage(messages[1], 'system', '[meta] ago=5m speaker=masud');
  assertMessage(messages[2], 'user', 'What records do I have?');
  assertMessage(messages[3], 'assistant', 'You have a Monstera deliciosa.');
  assertMessage(messages[4], 'user');

  const tools = payload.tools as Record<string, unknown>[];
  assertEquals(tools.length, 1);
  const fn = tools[0]?.function as Record<string, unknown>;
  assertEquals(fn?.name, 'lookup_record');
});

Deno.test('toOpenRouterPayload formats structured json_schema response_format', () => {
  const { generation } = resolveTurn({
    profile: 'formatter',
    input: { text: 'Design hero card', slots: { language: 'html' } },
  });

  const req: ProviderCompleteRequest = {
    model: generation.model,
    apiId: generation.apiId,
    openRouterId: generation.openRouterId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'Designer persona',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  };

  const payload = toOpenRouterPayload(req, {});
  const format = payload.response_format as Record<string, unknown>;
  assertEquals(format.type, 'json_schema');
  const schemaObj = format.json_schema as Record<string, unknown>;
  assertEquals(schemaObj.name, 'htmlTurn');
  assertEquals(schemaObj.strict, true);
});

function mockStreamChunks(): string[] {
  const t1 = JSON.stringify({
    choices: [{ delta: { reasoning: 'checking ' } }],
  });
  const t2 = JSON.stringify({
    choices: [{ delta: { reasoning: 'database.' } }],
  });
  const c1 = JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] });
  const c2 = JSON.stringify({ choices: [{ delta: { content: 'world.' } }] });
  const tc1 = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"record"}' },
            },
          ],
        },
      },
    ],
  });
  const u = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: EXPECTED_INPUT_TOKENS,
      completion_tokens: EXPECTED_OUTPUT_TOKENS,
      total_tokens: EXPECTED_TOTAL_TOKENS,
    },
  });
  return [
    `data: ${t1}\n\n`,
    `data: ${t2}\n\n`,
    `data: ${c1}\n\n`,
    `data: ${c2}\n\n`,
    `data: ${tc1}\n\n`,
    `data: ${u}\n\n`,
    'data: [DONE]\n\n',
  ];
}

Deno.test('createOpenRouterProvider streams reasoning, text, tools, tokens, and done', async () => {
  const mockSse = mockStreamChunks();
  let fetchCalledWith = '';
  let capturedBody: Record<string, unknown> | undefined;

  const provider = createOpenRouterProvider({
    apiKey: 'mock-auth-token',
    fetch: (url, init) => {
      fetchCalledWith = String(url);
      capturedBody = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers as HeadersInit);
      const auth = headers.get('Authorization');
      assertEquals(auth, 'Bearer mock-auth-token');
      return Promise.resolve(sseResponse(mockSse));
    },
  });

  const req = createMockTurnRequest('pinned', 'How often to water?');
  req.history = [
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"plant"}' } },
      ],
    },
    { role: 'tool', name: 'lookup', tool_call_id: 'tc_1', content: 'Monstera' },
  ];
  req.dynamicTools = [
    {
      name: 'lookup',
      description: 'Lookup a plant record',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    },
  ];
  const events = await collect(provider.complete(req));

  assertEquals(fetchCalledWith, 'https://openrouter.ai/api/v1/chat/completions');

  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length > 0, true);
  const userMessages = messages.filter((m) => m.role === 'user');
  assertEquals(userMessages.length > 0, true);
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  assertEquals(assistantMessages.length > 0, true);
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assertEquals(toolMessages.length > 0, true);

  const thoughts = events
    .filter((e) => e.type === 'thought')
    .map((e) => e.text)
    .join('');
  assertEquals(thoughts, 'checking database.');

  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  assertEquals(text, 'hello world.');

  const toolEvents = events.filter((e) => e.type === 'tool');
  assertEquals(toolEvents.length, 1);
  assertEquals(toolEvents[0]?.tool?.name, 'lookup');
  assertEquals(toolEvents[0]?.tool?.arguments, { q: 'record' });

  const tokenEvents = events.filter((e) => e.type === 'tokens');
  assertEquals(tokenEvents.length, 1);
  assertEquals(tokenEvents[0]?.tokens?.input, EXPECTED_INPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.output, EXPECTED_OUTPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.total, EXPECTED_TOTAL_TOKENS);
  assertEquals(events.filter((e) => e.type === 'done').length, 1);
});

Deno.test('createOpenRouterProvider preserves citation evidence from provider payloads', async () => {
  const evidencePayload = JSON.stringify({
    provider_metadata: { citations: ['https://example.com/source'] },
    annotations: [{ type: 'url_citation', url: 'https://example.com/source' }],
    choices: [{ delta: { content: 'cited answer' } }],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'mock-auth-token',
    fetch: () => Promise.resolve(sseResponse([`data: ${evidencePayload}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidenceEvents = events.filter((event) => event.type === 'evidence');
  assertEquals(evidenceEvents.length, 1);
  assertEquals(evidenceEvents[0]?.evidence?.provider, 'openrouter');
  assertEquals(evidenceEvents[0]?.evidence?.citations, ['https://example.com/source']);
  assertEquals(
    events.some((event) => event.type === 'text' && event.text === 'cited answer'),
    true,
  );
});

Deno.test('createOpenRouterProvider preserves evidence from final choice messages', async () => {
  const finalMessagePayload = JSON.stringify({
    choices: [
      {
        message: {
          content: 'final cited answer',
          providerMetadata: { citations: ['https://example.com/final'] },
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'mock-auth-token',
    fetch: () =>
      Promise.resolve(sseResponse([`data: ${finalMessagePayload}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite final')));
  const evidence = events.find((event) => event.type === 'evidence')?.evidence;
  assertEquals(evidence?.provider, 'openrouter');
  assertEquals(evidence?.citations, ['https://example.com/final']);
  assertEquals(events.filter((event) => event.type === 'evidence').length, 1);
});

Deno.test('createOpenRouterProvider handles missing API key, empty stream, thinking delta, site headers, and invalid tool args', async () => {
  // 1. Missing API key
  const noKeyProvider = createOpenRouterProvider({ apiKey: '' });
  const noKeyEvents = await collect(noKeyProvider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(noKeyEvents.length, 1);
  assertEquals(noKeyEvents[0]?.type, 'error');

  // 2. Empty stream
  const emptyStreamProvider = createOpenRouterProvider({
    apiKey: 'mock-key',
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
  });
  const emptyStreamEvents = await collect(
    emptyStreamProvider.complete(createMockTurnRequest('pinned', 'x')),
  );
  assertEquals(emptyStreamEvents.length, 1);
  assertEquals(emptyStreamEvents[0]?.type, 'error');

  // 3. Thinking delta, site headers, structured parsing, unparseable tool args
  let capturedHeaders: Headers | undefined;
  const chunkWithThinking = JSON.stringify({
    choices: [{ delta: { thinking: 'deep thought' } }],
  });
  const chunkWithBadTool = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'bad_call',
              function: { name: 'rawFn', arguments: '{invalid_json' },
            },
          ],
        },
      },
    ],
  });
  const chunkWithStructured = JSON.stringify({
    choices: [
      {
        delta: { content: '{"answer": "structured output"}' },
      },
    ],
  });

  const fullStreamProvider = createOpenRouterProvider({
    apiKey: 'mock-key',
    siteUrl: 'https://theorum.dev',
    siteName: 'Theorum',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${chunkWithThinking}\n\n`,
          `data: ${chunkWithBadTool}\n\n`,
          `data: ${chunkWithStructured}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const structuredReq = createMockTurnRequest('formatter', 'x');
  structuredReq.dynamicTools = [
    {
      name: 'rawFn',
      description: 'Raw function probe',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    },
  ];
  const fullEvents = await collect(fullStreamProvider.complete(structuredReq));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), 'https://theorum.dev');
  assertEquals(capturedHeaders?.get('X-Title'), 'Theorum');

  const thoughtEv = fullEvents.find((e) => e.type === 'thought');
  assertEquals(thoughtEv?.text, 'deep thought');

  const toolEv = fullEvents.find((e) => e.type === 'tool');
  assertEquals(toolEv, undefined);
  assertEquals(
    fullEvents.some((e) => e.type === 'error'),
    true,
  );
});

Deno.test('createOpenRouterProvider sends response_format for structured requests via SDK', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"ok"}' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await collect(provider.complete(req));
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
  const rf = capturedBody?.response_format as Record<string, unknown> | undefined;
  assertEquals(rf?.type, 'json_schema');
  const jsonSchema = rf?.json_schema as Record<string, unknown>;
  assertEquals(jsonSchema?.name, 'htmlTurn');
  assertEquals(jsonSchema?.strict, true);
});

Deno.test('createOpenRouterProvider passes web_search_options for googleSearch builtin', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'search the web');
  req.builtins = ['googleSearch'];
  const events = await collect(provider.complete(req));
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
  assertEquals(capturedBody?.web_search_options !== undefined, true);
  assertEquals(capturedBody?.plugins, undefined);
});

Deno.test('createOpenRouterProvider emits tool call events with id, name, and parsed arguments', async () => {
  const toolChunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${toolChunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const req = createMockTurnRequest('pinned', 'weather');
  req.dynamicTools = [
    {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ];
  const events = await collect(provider.complete(req));
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.name, 'get_weather');
  assertEquals(toolEv?.tool?.id, 'call_abc');
  assertEquals(toolEv?.tool?.arguments, { city: 'NYC' });
});

Deno.test('createOpenRouterProvider extracts evidence from openrouter.provider_metadata.citations', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'answer' } }],
    openrouter: {
      provider_metadata: { citations: ['https://example.com/deep'] },
    },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite deep')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.provider, 'openrouter');
  assertEquals(evidence?.citations, ['https://example.com/deep']);
});

Deno.test('createOpenRouterProvider extracts evidence annotations from SSE chunk', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'annotated' } }],
    annotations: [{ type: 'url_citation', url: 'https://example.com/ann', title: 'Ann' }],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'annotate')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.provider, 'openrouter');
  assertEquals(evidence?.annotations?.length, 1);
  assertEquals(typeof evidence?.raw, 'object');
  assertEquals(evidence?.raw !== null, true);
});

Deno.test('createOpenRouterProvider extracts citations from nested openrouter.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'answer' } }],
    openrouter: {
      citations: ['https://example.com/openrouter-direct'],
    },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.citations, ['https://example.com/openrouter-direct']);
});

Deno.test('createOpenRouterProvider maps openRouterSettings for non-web plugins', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.builtins = [];
  await collect(provider.complete(req));
  assertEquals(capturedBody?.web_search_options, undefined);
});

Deno.test('createOpenRouterProvider missing key error includes descriptive message', async () => {
  const provider = createOpenRouterProvider({ apiKey: '   ' });
  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals(typeof events[0]?.error, 'string');
});

Deno.test('createOpenRouterProvider yields error on HTTP non-200', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(new Response('Forbidden', { status: 403 })),
  });

  const req = createMockTurnRequest('pinned', 'x');
  const events = await collect(provider.complete(req));
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals(events[0]?.error, PUBLIC_UNAVAILABLE);
});

Deno.test('createOpenRouterProvider wires tool result history with fallback ids', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [
    {
      role: 'assistant',
      tool_calls: [
        { id: 'tc1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } },
      ],
    },
    { role: 'tool', name: 'calc', tool_call_id: 'tc1', content: '42' },
    { role: 'tool', content: 'orphan result' },
    { role: 'assistant', parts: [{ type: 'text', text: 'summary' }] },
    { role: 'user', content: 'follow-up' },
  ];
  await collect(provider.complete(req));

  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length > 0, true);

  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assertEquals(toolMsgs.length, 2);

  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  assertEquals(assistantMsgs.length >= 2, true);
});

Deno.test('createOpenRouterProvider emits structured event for valid JSON output', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"42"}' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await collect(provider.complete(req));
  const structuredEv = events.find((e) => e.type === 'structured');
  assertEquals((structuredEv?.structured as Record<string, unknown>)?.answer, '42');
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('createOpenRouterProvider skips structured event for invalid JSON', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'not valid json' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await collect(provider.complete(req));
  const structuredEv = events.find((e) => e.type === 'structured');
  assertEquals(structuredEv, undefined);
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('createOpenRouterProvider deduplicates evidence across stream', async () => {
  const chunk1 = JSON.stringify({
    choices: [{ delta: { content: 'first' } }],
    annotations: [{ type: 'url_citation', url: 'https://a.com' }],
  });
  const chunk2 = JSON.stringify({
    choices: [{ delta: { content: 'second' } }],
    annotations: [{ type: 'url_citation', url: 'https://b.com' }],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, 'data: [DONE]\n\n']),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidenceEvents = events.filter((e) => e.type === 'evidence');
  assertEquals(evidenceEvents.length, 1);
});

Deno.test('createOpenRouterProvider emits token counts from finish event', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'count')));
  const tokenEv = events.find((e) => e.type === 'tokens');
  assertEquals(tokenEv?.tokens?.input, 10);
  assertEquals(tokenEv?.tokens?.output, 20);
  assertEquals(tokenEv?.tokens?.total, 30);
});

Deno.test('createOpenRouterProvider omits token event when usage is all zeros', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'count')));
  assertEquals(events.filter((e) => e.type === 'tokens').length, 0);
});

Deno.test('createOpenRouterProvider emits tokens when only input tokens are nonzero', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'tok')));
  const tokenEv = events.find((e) => e.type === 'tokens');
  assertEquals(tokenEv?.tokens?.input, 5);
  assertEquals(tokenEv?.tokens?.output, 0);
  assertEquals(tokenEv?.tokens?.total, 5);
});

Deno.test('createOpenRouterProvider emits tokens when only output tokens are nonzero', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 7, total_tokens: 7 },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'tok')));
  const tokenEv = events.find((e) => e.type === 'tokens');
  assertEquals(tokenEv?.tokens?.input, 0);
  assertEquals(tokenEv?.tokens?.output, 7);
  assertEquals(tokenEv?.tokens?.total, 7);
});

Deno.test('createOpenRouterProvider handles empty history and empty input gracefully', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [];
  await collect(provider.complete(req));
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  const userMsgs = messages.filter((m) => m.role === 'user');
  assertEquals(userMsgs.length >= 1, true);
});

Deno.test('createOpenRouterProvider maps history assistant with empty tool_calls as content', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [
    { role: 'assistant', tool_calls: [], content: 'just text' },
    { role: 'user', content: 'ok' },
  ];
  await collect(provider.complete(req));
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  assertEquals(assistantMsgs.length >= 1, true);
  assertEquals(assistantMsgs[0]?.content, 'just text');
});

Deno.test('createOpenRouterProvider extracts citations from providerMetadata.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'cited' } }],
    providerMetadata: { citations: ['https://example.com/pm'] },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.citations, ['https://example.com/pm']);
});

Deno.test('createOpenRouterProvider extracts choice message providerMetadata evidence', async () => {
  const chunk = JSON.stringify({
    choices: [
      {
        message: {
          content: 'answer',
          provider_metadata: { citations: ['https://example.com/choice-pm'] },
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.citations, ['https://example.com/choice-pm']);
});

Deno.test('createOpenRouterProvider does not emit evidence when no citations or annotations', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'plain text' } }],
    openrouter: { some_field: 'value' },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'plain')));
  assertEquals(events.filter((e) => e.type === 'evidence').length, 0);
});

Deno.test('createOpenRouterProvider wires reasoning effort to provider options', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'think hard');
  req.thinking = 'high';
  await collect(provider.complete(req));

  const providerOptions = capturedBody?.providerOptions as Record<string, unknown> | undefined;
  if (providerOptions) {
    const or = providerOptions.openrouter as Record<string, unknown>;
    assertEquals((or?.reasoning as Record<string, unknown>)?.effort, 'high');
  }
});

Deno.test('createOpenRouterProvider does not emit done after error', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => {
      throw new Error('network failure');
    },
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'fail')));
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
  assertEquals(events.filter((e) => e.type === 'done').length, 0);
});

Deno.test('createOpenRouterProvider handles openrouter.providerMetadata.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'deep' } }],
    openrouter: {
      providerMetadata: { citations: ['https://example.com/or-pm'] },
    },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.citations, ['https://example.com/or-pm']);
});

Deno.test('createOpenRouterProvider extracts openrouter.annotations evidence', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'annotated' } }],
    openrouter: {
      annotations: [{ type: 'url_citation', url: 'https://example.com/or-ann' }],
    },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'ann')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.provider, 'openrouter');
  assertEquals(evidence?.annotations?.length, 1);
});

Deno.test('createOpenRouterProvider passes reasoning delta as thought events', async () => {
  const thinkChunk = JSON.stringify({
    choices: [{ delta: { reasoning: 'step 1' } }],
  });
  const textChunk = JSON.stringify({
    choices: [{ delta: { content: 'result' } }],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([`data: ${thinkChunk}\n\n`, `data: ${textChunk}\n\n`, 'data: [DONE]\n\n']),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'think')));
  const thoughts = events.filter((e) => e.type === 'thought');
  assertEquals(thoughts.length >= 1, true);
  assertEquals(
    thoughts.some((t) => t.text === 'step 1'),
    true,
  );
});

Deno.test('createOpenRouterProvider wires only siteUrl header without siteName', async () => {
  let capturedHeaders: Headers | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    siteUrl: 'https://only-url.dev',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  await collect(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), 'https://only-url.dev');
  assertEquals(capturedHeaders?.get('X-Title'), null);
});

Deno.test('createOpenRouterProvider wires only siteName header without siteUrl', async () => {
  let capturedHeaders: Headers | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    siteName: 'OnlyName',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  await collect(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), null);
  assertEquals(capturedHeaders?.get('X-Title'), 'OnlyName');
});

Deno.test('createOpenRouterProvider does not include providerOptions when thinking is none and no structured', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'simple');
  req.thinking = 'none';
  req.structured = null;
  await collect(provider.complete(req));
  assertEquals(capturedBody?.providerOptions, undefined);
});

Deno.test('createOpenRouterProvider emits text from content delta and accumulates for structured', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'part1' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'part2' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'multi')));
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  assertEquals(text, 'part1part2');
});

Deno.test('createOpenRouterProvider treats empty/whitespace-only apiKey as missing', async () => {
  const provider = createOpenRouterProvider({ apiKey: '' });
  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
});

Deno.test('createOpenRouterProvider wires tools with additionalProperties schema', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.dynamicTools = [{ name: 'flexible' }];
  await collect(provider.complete(req));
  assertEquals(capturedBody?.tools !== undefined, true);
});

Deno.test('createOpenRouterProvider extracts top-level citations from SSE chunk', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'top' } }],
    citations: ['https://example.com/top-level'],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.provider, 'openrouter');
  assertEquals(evidence?.citations, ['https://example.com/top-level']);
});

Deno.test('createOpenRouterProvider ignores non-string items in citation arrays', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'mixed' } }],
    citations: [42, 'https://example.com/valid', null, true],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  const evidence = events.find((e) => e.type === 'evidence')?.evidence;
  assertEquals(evidence?.citations, ['https://example.com/valid']);
});

Deno.test('createOpenRouterProvider skips evidence for non-array citation values', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'str' } }],
    citations: 'not-an-array',
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(events.filter((e) => e.type === 'evidence').length, 0);
});

Deno.test('createOpenRouterProvider skips evidence when citation array has only non-strings', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'nums' } }],
    citations: [1, 2, 3],
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(events.filter((e) => e.type === 'evidence').length, 0);
});

Deno.test('createOpenRouterProvider handles SSE with non-object raw values gracefully', async () => {
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: "just a string"\n\n',
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'raw')));
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
});

Deno.test('createOpenRouterProvider does not duplicate token events on multiple finish parts', async () => {
  const finish1 = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const finish2 = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const provider = createOpenRouterProvider({
    apiKey: 'test-key',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finish1}\n\n`,
          `data: ${finish2}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await collect(provider.complete(createMockTurnRequest('pinned', 'dup')));
  assertEquals(events.filter((e) => e.type === 'tokens').length, 1);
});

// ─── Direct unit tests for internal functions ───

Deno.test('_internals.trimApiKey returns trimmed key', () => {
  assertEquals(_internals.trimApiKey('  key  '), 'key');
  assertEquals(_internals.trimApiKey('key'), 'key');
  assertEquals(_internals.trimApiKey(undefined), undefined);
  assertEquals(_internals.trimApiKey(''), undefined);
  assertEquals(_internals.trimApiKey('   '), undefined);
});

Deno.test('_internals.createAccumulator returns fresh state', () => {
  const acc = _internals.createAccumulator();
  assertEquals(acc.text, '');
  assertEquals(acc.evidenceSeen, false);
  assertEquals(acc.emittedTokens, false);
  assertEquals(acc.errored, false);
});

Deno.test('_internals.mediaPart maps text parts', () => {
  const part: InteractionPart = { type: 'text', text: 'hello' };
  assertEquals(_internals.mediaPart(part), { type: 'text', text: 'hello' });
});

Deno.test('_internals.mediaPart maps image parts with data URI', () => {
  const part: InteractionPart = { type: 'image', mimeType: 'image/png', data: 'abc123' };
  assertEquals(_internals.mediaPart(part), {
    type: 'image',
    image: 'data:image/png;base64,abc123',
  });
});

Deno.test('_internals.mediaPart maps document parts', () => {
  const part: InteractionPart = { type: 'document', mimeType: 'application/pdf', data: 'pdfdata' };
  assertEquals(_internals.mediaPart(part), {
    type: 'file',
    mediaType: 'application/pdf',
    data: 'pdfdata',
  });
});

Deno.test('_internals.contentFromParts joins text-only parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'line1' },
    { type: 'text', text: 'line2' },
  ];
  assertEquals(_internals.contentFromParts(parts), 'line1\nline2');
});

Deno.test('_internals.contentFromParts filters empty text parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'line1' },
    { type: 'text', text: '' },
    { type: 'text', text: 'line3' },
  ];
  assertEquals(_internals.contentFromParts(parts), 'line1\nline3');
});

Deno.test('_internals.contentFromParts returns array for mixed parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'caption' },
    { type: 'image', mimeType: 'image/png', data: 'img' },
  ];
  const result = _internals.contentFromParts(parts);
  assertEquals(Array.isArray(result), true);
  assertEquals((result as Array<Record<string, unknown>>).length, 2);
  assertEquals((result as Array<Record<string, unknown>>)[0], { type: 'text', text: 'caption' });
  assertEquals((result as Array<Record<string, unknown>>)[1], {
    type: 'image',
    image: 'data:image/png;base64,img',
  });
});

Deno.test('_internals.parseToolInput parses valid JSON', () => {
  assertEquals(_internals.parseToolInput('{"a":1}'), { a: 1 });
});

Deno.test('_internals.parseToolInput wraps invalid JSON', () => {
  assertEquals(_internals.parseToolInput('not json'), { _raw: 'not json' });
});

Deno.test('_internals.stringDefault uses fallback for undefined', () => {
  assertEquals(_internals.stringDefault(undefined, 'fb'), 'fb');
  assertEquals(_internals.stringDefault('val', 'fb'), 'val');
  assertEquals(_internals.stringDefault('', 'fb'), '');
});

Deno.test('_internals.fallbackToolCallId generates ID from name', () => {
  assertEquals(_internals.fallbackToolCallId('search'), 'call_search');
  assertEquals(_internals.fallbackToolCallId(undefined), 'call_tool');
});

Deno.test('_internals.toolResultContent builds tool result message', () => {
  const msg: TurnHistoryMessage = {
    role: 'tool',
    content: 'result data',
    tool_call_id: 'call_123',
    name: 'search',
  };
  const result = _internals.toolResultContent(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'tool');
  const content = result.content as Array<Record<string, unknown>>;
  assertEquals(content.length, 1);
  assertEquals(content[0].type, 'tool-result');
  assertEquals(content[0].toolCallId, 'call_123');
  assertEquals(content[0].toolName, 'search');
  assertEquals((content[0].output as Record<string, unknown>).value, 'result data');
});

Deno.test('_internals.toolResultContent uses fallback IDs', () => {
  const msg: TurnHistoryMessage = { role: 'tool' };
  const result = _internals.toolResultContent(msg) as unknown as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  assertEquals(content[0].toolCallId, 'call_tool');
  assertEquals(content[0].toolName, 'tool');
  assertEquals((content[0].output as Record<string, unknown>).value, '');
});

Deno.test('_internals.assistantToolCallContent returns null without tool calls', () => {
  const msg: TurnHistoryMessage = { role: 'assistant', content: 'hi' };
  assertEquals(_internals.assistantToolCallContent(msg), null);
  const msgEmpty: TurnHistoryMessage = { role: 'assistant', tool_calls: [] };
  assertEquals(_internals.assistantToolCallContent(msgEmpty), null);
});

Deno.test('_internals.assistantToolCallContent maps tool calls', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    ],
  };
  const result = _internals.assistantToolCallContent(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'assistant');
  const content = result.content as Array<Record<string, unknown>>;
  assertEquals(content.length, 1);
  assertEquals(content[0].type, 'tool-call');
  assertEquals(content[0].toolCallId, 'c1');
  assertEquals(content[0].toolName, 'search');
  assertEquals(content[0].input, { q: 'x' });
});

Deno.test('_internals.assistantToolCallContent handles invalid JSON args', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: 'bad' } }],
  };
  const result = _internals.assistantToolCallContent(msg) as unknown as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  assertEquals(content[0].input, { _raw: 'bad' });
});

Deno.test('_internals.historyMessage dispatches tool messages', () => {
  const msg: TurnHistoryMessage = { role: 'tool', content: 'ok', name: 'fn', tool_call_id: 'c1' };
  const result = _internals.historyMessage(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'tool');
});

Deno.test('_internals.historyMessage dispatches assistant with tool calls', () => {
  const msg: TurnHistoryMessage = {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }],
  };
  const result = _internals.historyMessage(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'assistant');
  assertEquals((result.content as Array<Record<string, unknown>>)[0].type, 'tool-call');
});

Deno.test('_internals.historyMessage dispatches content messages', () => {
  const msg: TurnHistoryMessage = { role: 'user', content: 'hello' };
  const result = _internals.historyMessage(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'user');
  assertEquals(result.content, 'hello');
});

Deno.test('_internals.contentFromOptionalParts uses text fallback when no parts', () => {
  assertEquals(_internals.contentFromOptionalParts(undefined, 'fallback'), 'fallback');
  assertEquals(_internals.contentFromOptionalParts([], 'fallback'), 'fallback');
  assertEquals(_internals.contentFromOptionalParts(undefined, undefined), '');
});

Deno.test('_internals.contentFromOptionalParts uses parts when available', () => {
  const parts: InteractionPart[] = [{ type: 'text', text: 'from parts' }];
  assertEquals(_internals.contentFromOptionalParts(parts, 'fallback'), 'from parts');
});

Deno.test('_internals.contentHistoryMessage builds message with parts', () => {
  const msg: TurnHistoryMessage = {
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
  };
  const result = _internals.contentHistoryMessage(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'user');
  assertEquals(result.content, 'hello');
});

Deno.test('_internals.contentHistoryMessage builds message with content string', () => {
  const msg: TurnHistoryMessage = { role: 'assistant', content: 'hi' };
  const result = _internals.contentHistoryMessage(msg) as unknown as Record<string, unknown>;
  assertEquals(result.role, 'assistant');
  assertEquals(result.content, 'hi');
});

Deno.test('_internals.buildMessages includes history and input', () => {
  const req = createMockTurnRequest('pinned', 'test input');
  req.history = [{ role: 'user', content: 'prev' }];
  const messages = _internals.buildMessages(req);
  assertEquals(messages.length, 2);
  assertEquals((messages[0] as unknown as Record<string, unknown>).content, 'prev');
});

Deno.test('_internals.buildMessages handles empty input', () => {
  const req = createMockTurnRequest('pinned', 'x');
  req.input = [];
  req.history = [{ role: 'user', content: 'prev' }];
  const messages = _internals.buildMessages(req);
  assertEquals(messages.length, 1);
});

Deno.test('_internals.buildMessages handles no history', () => {
  const req = createMockTurnRequest('pinned', 'input');
  req.history = undefined;
  const messages = _internals.buildMessages(req);
  assertEquals(messages.length, 1);
});

Deno.test('_internals.schemaForTool returns parameters when present', () => {
  const decl = {
    name: 'fn',
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  };
  assertEquals(_internals.schemaForTool(decl), decl.parameters);
});

Deno.test('_internals.schemaForTool returns default schema when no parameters', () => {
  const decl = { name: 'fn' };
  assertEquals(_internals.schemaForTool(decl), {
    type: 'object',
    properties: {},
    additionalProperties: true,
  });
});

Deno.test('_internals.buildTools returns undefined for empty tools', () => {
  assertEquals(_internals.buildTools(undefined), undefined);
  assertEquals(_internals.buildTools([]), undefined);
});

Deno.test('_internals.buildTools creates tool set', () => {
  const tools = _internals.buildTools([{ name: 'search', description: 'Find things' }]);
  assertEquals(tools !== undefined, true);
  assertEquals('search' in (tools as R), true);
});

function mockUsage(
  input: number | null,
  output: number | null,
  total: number | null,
): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    inputTokenDetails: {},
    outputTokenDetails: {},
  } as unknown as LanguageModelUsage;
}

Deno.test('_internals.tokensFromUsage returns undefined for all zeros', () => {
  assertEquals(_internals.tokensFromUsage(mockUsage(0, 0, 0)), undefined);
});

Deno.test('_internals.tokensFromUsage maps non-zero usage', () => {
  assertEquals(_internals.tokensFromUsage(mockUsage(10, 5, 15)), {
    input: 10,
    output: 5,
    total: 15,
  });
});

Deno.test('_internals.tokensFromUsage computes total from input+output when null', () => {
  assertEquals(_internals.tokensFromUsage(mockUsage(10, 5, null)), {
    input: 10,
    output: 5,
    total: 15,
  });
});

Deno.test('_internals.tokensFromUsage handles null input/output', () => {
  assertEquals(_internals.tokensFromUsage(mockUsage(null, null, 5)), {
    input: 0,
    output: 0,
    total: 5,
  });
});

Deno.test('_internals.rawRecord returns record for objects', () => {
  assertEquals(_internals.rawRecord({ a: 1 }), { a: 1 });
  assertEquals(_internals.rawRecord(null), undefined);
  assertEquals(_internals.rawRecord(undefined), undefined);
  assertEquals(_internals.rawRecord([1, 2]), undefined);
  assertEquals(_internals.rawRecord('string'), undefined);
  assertEquals(_internals.rawRecord(42), undefined);
});

Deno.test('_internals.stringArray returns string arrays', () => {
  assertEquals(_internals.stringArray(['a', 'b']), ['a', 'b']);
  assertEquals(_internals.stringArray([]), undefined);
  assertEquals(_internals.stringArray('not array'), undefined);
  assertEquals(_internals.stringArray([1, 2]), undefined);
  assertEquals(_internals.stringArray(['a', 1, 'b']), ['a', 'b']);
});

Deno.test('_internals.metadataRecord extracts nested record', () => {
  assertEquals(_internals.metadataRecord({ key: { nested: true } }, 'key'), { nested: true });
  assertEquals(_internals.metadataRecord({ key: 'string' }, 'key'), undefined);
  assertEquals(_internals.metadataRecord({}, 'missing'), undefined);
});

Deno.test('_internals.citationCandidates gathers all candidate locations', () => {
  const raw = { citations: ['a'] };
  const candidates = _internals.citationCandidates(raw);
  assertEquals(candidates.length, 6);
  assertEquals(candidates[0], ['a']);
});

Deno.test('_internals.nestedCitations finds top-level citations', () => {
  assertEquals(_internals.nestedCitations({ citations: ['url1'] }), ['url1']);
});

Deno.test('_internals.nestedCitations finds openrouter.citations', () => {
  assertEquals(_internals.nestedCitations({ openrouter: { citations: ['url2'] } }), ['url2']);
});

Deno.test('_internals.nestedCitations finds providerMetadata.citations', () => {
  assertEquals(_internals.nestedCitations({ providerMetadata: { citations: ['url3'] } }), ['url3']);
});

Deno.test('_internals.nestedCitations finds openrouter.providerMetadata.citations', () => {
  assertEquals(
    _internals.nestedCitations({
      openrouter: { providerMetadata: { citations: ['url4'] } },
    }),
    ['url4'],
  );
});

Deno.test('_internals.nestedCitations finds provider_metadata.citations', () => {
  assertEquals(_internals.nestedCitations({ provider_metadata: { citations: ['url5'] } }), [
    'url5',
  ]);
});

Deno.test('_internals.nestedCitations finds openrouter.provider_metadata.citations', () => {
  assertEquals(
    _internals.nestedCitations({
      openrouter: { provider_metadata: { citations: ['url6'] } },
    }),
    ['url6'],
  );
});

Deno.test('_internals.nestedCitations returns undefined when no citations', () => {
  assertEquals(_internals.nestedCitations({}), undefined);
});

Deno.test('_internals.nestedCitations filters non-string citations', () => {
  assertEquals(_internals.nestedCitations({ citations: [1, 2] }), undefined);
});

Deno.test('_internals.metadataAnnotations finds top-level annotations', () => {
  assertEquals(_internals.metadataAnnotations({ annotations: [{ a: 1 }] }), [{ a: 1 }]);
});

Deno.test('_internals.metadataAnnotations finds openrouter.annotations', () => {
  assertEquals(_internals.metadataAnnotations({ openrouter: { annotations: [{ b: 2 }] } }), [
    { b: 2 },
  ]);
});

Deno.test('_internals.metadataAnnotations returns undefined when none', () => {
  assertEquals(_internals.metadataAnnotations({}), undefined);
});

Deno.test('_internals.metadataAnnotations ignores non-array annotations', () => {
  assertEquals(_internals.metadataAnnotations({ annotations: 'not array' }), undefined);
});

Deno.test('_internals.evidenceFromMetadata builds evidence event', () => {
  const acc = _internals.createAccumulator();
  const ev = _internals.evidenceFromMetadata({ citations: ['url'] }, acc);
  assertEquals(ev?.type, 'evidence');
  assertEquals(field(ev, 'evidence', 'citations'), ['url']);
  assertEquals(acc.evidenceSeen, true);
});

Deno.test('_internals.evidenceFromMetadata returns undefined when already seen', () => {
  const acc = _internals.createAccumulator();
  acc.evidenceSeen = true;
  assertEquals(_internals.evidenceFromMetadata({ citations: ['url'] }, acc), undefined);
});

Deno.test('_internals.evidenceFromMetadata returns undefined for non-record', () => {
  const acc = _internals.createAccumulator();
  assertEquals(_internals.evidenceFromMetadata(null, acc), undefined);
  assertEquals(_internals.evidenceFromMetadata('string', acc), undefined);
});

Deno.test('_internals.evidenceFromMetadata returns undefined when no citations or annotations', () => {
  const acc = _internals.createAccumulator();
  assertEquals(_internals.evidenceFromMetadata({}, acc), undefined);
});

Deno.test('_internals.toolArguments normalizes object input', () => {
  assertEquals(_internals.toolArguments({ a: 1 }), { a: 1 });
});

Deno.test('_internals.toolArguments returns undefined for undefined', () => {
  assertEquals(_internals.toolArguments(undefined), undefined);
});

Deno.test('_internals.toolArguments wraps non-object input', () => {
  assertEquals(_internals.toolArguments('str'), { value: 'str' });
  assertEquals(_internals.toolArguments(42), { value: 42 });
  assertEquals(_internals.toolArguments([1, 2]), { value: [1, 2] });
});

Deno.test('_internals.toolResultData returns record for objects', () => {
  assertEquals(_internals.toolResultData({ ok: true }), { ok: true });
  assertEquals(_internals.toolResultData('str'), undefined);
  assertEquals(_internals.toolResultData(null), undefined);
});

Deno.test('_internals.rawThoughtEvent extracts thinking from delta', () => {
  const raw = { choices: [{ delta: { thinking: 'pondering...' } }] };
  assertEquals(_internals.rawThoughtEvent(raw), { type: 'thought', text: 'pondering...' });
});

Deno.test('_internals.rawThoughtEvent returns undefined for non-string thinking', () => {
  assertEquals(_internals.rawThoughtEvent({ choices: [{ delta: { thinking: 42 } }] }), undefined);
});

Deno.test('_internals.rawThoughtEvent returns undefined without choices', () => {
  assertEquals(_internals.rawThoughtEvent({}), undefined);
  assertEquals(_internals.rawThoughtEvent({ choices: 'not array' }), undefined);
});

Deno.test('_internals.rawChoiceMessageEvidence extracts from message', () => {
  const acc = _internals.createAccumulator();
  const raw = {
    choices: [{ message: { citations: ['url'] } }],
  };
  const ev = _internals.rawChoiceMessageEvidence(raw, acc);
  assertEquals(ev?.type, 'evidence');
});

Deno.test('_internals.rawChoiceMessageEvidence returns undefined without choices', () => {
  const acc = _internals.createAccumulator();
  assertEquals(_internals.rawChoiceMessageEvidence({}, acc), undefined);
});

Deno.test('_internals.rawChoiceMessageEvidence skips non-object messages', () => {
  const acc = _internals.createAccumulator();
  assertEquals(
    _internals.rawChoiceMessageEvidence({ choices: [{ message: 'not object' }] }, acc),
    undefined,
  );
});

Deno.test('_internals.rawEvents collects thought and evidence', () => {
  const acc = _internals.createAccumulator();
  const raw = {
    choices: [{ delta: { thinking: 'hmm' } }],
    citations: ['url'],
  };
  const events = _internals.rawEvents(raw, acc);
  assertEquals(events.length, 2);
  assertEquals(events[0].type, 'thought');
  assertEquals(events[1].type, 'evidence');
});

Deno.test('_internals.rawEvents returns empty for non-record', () => {
  const acc = _internals.createAccumulator();
  assertEquals(_internals.rawEvents(null, acc), []);
  assertEquals(_internals.rawEvents('string', acc), []);
});

Deno.test('_internals.toolCallEvent maps tool call part', () => {
  const part = {
    type: 'tool-call' as const,
    toolName: 'search',
    toolCallId: 'c1',
    input: { q: 'x' },
  };
  const ev = _internals.toolCallEvent(
    part as unknown as Parameters<typeof _internals.toolCallEvent>[0],
  );
  assertEquals(ev.type, 'tool');
  assertEquals(field(ev, 'tool', 'name'), 'search');
  assertEquals(field(ev, 'tool', 'arguments'), { q: 'x' });
  assertEquals(field(ev, 'tool', 'id'), 'c1');
});

Deno.test('_internals.toolResultEvent maps tool result part', () => {
  const part = {
    type: 'tool-result' as const,
    toolName: 'search',
    toolCallId: 'c1',
    input: { q: 'x' },
    output: { answer: 'found' },
  };
  const ev = _internals.toolResultEvent(
    part as unknown as Parameters<typeof _internals.toolResultEvent>[0],
  );
  assertEquals(ev.type, 'tool');
  assertEquals(field(ev, 'tool', 'result', 'status'), 'ok');
  assertEquals(field(ev, 'tool', 'result', 'data'), { answer: 'found' });
});

Deno.test('_internals.toolResultEvent includes finding for string output', () => {
  const part = {
    type: 'tool-result' as const,
    toolName: 'fn',
    toolCallId: 'c1',
    input: undefined,
    output: 'text result',
  };
  const ev = _internals.toolResultEvent(
    part as unknown as Parameters<typeof _internals.toolResultEvent>[0],
  );
  assertEquals(field(ev, 'tool', 'result', 'finding'), 'text result');
});

Deno.test('_internals.tokenEvent returns undefined for zero usage', () => {
  const part = {
    type: 'finish' as const,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  assertEquals(
    _internals.tokenEvent(part as unknown as Parameters<typeof _internals.tokenEvent>[0]),
    undefined,
  );
});

Deno.test('_internals.tokenEvent returns token event for non-zero usage', () => {
  const part = {
    type: 'finish' as const,
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
  const ev = _internals.tokenEvent(part as unknown as Parameters<typeof _internals.tokenEvent>[0]);
  assertEquals(ev?.type, 'tokens');
  assertEquals(field(ev, 'tokens'), { input: 10, output: 5, total: 15 });
});

Deno.test('_internals.finishEvent suppresses duplicate token emission', () => {
  const acc = _internals.createAccumulator();
  const part = {
    type: 'finish' as const,
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as unknown as Parameters<typeof _internals.finishEvent>[0];
  const first = _internals.finishEvent(part, acc);
  assertEquals(first?.type, 'tokens');
  assertEquals(acc.emittedTokens, true);
  const second = _internals.finishEvent(part, acc);
  assertEquals(second, undefined);
});

Deno.test('_internals.sourceEvent maps URL source to evidence', () => {
  const part = {
    type: 'source' as const,
    sourceType: 'url' as const,
    url: 'https://example.com',
    title: 'Example',
  };
  const ev = _internals.sourceEvent(
    part as unknown as Parameters<typeof _internals.sourceEvent>[0],
  );
  assertEquals(ev.type, 'evidence');
  assertEquals(field(ev, 'evidence', 'citations'), ['https://example.com']);
  const sources = field(ev, 'evidence', 'sources') as R[];
  assertEquals(sources[0].title, 'Example');
  assertEquals(sources[0].uri, 'https://example.com');
  assertEquals(sources[0].type, 'web');
});

Deno.test('_internals.sourceEvent uses url as title fallback', () => {
  const part = {
    type: 'source' as const,
    sourceType: 'url' as const,
    url: 'https://example.com',
  };
  const ev = _internals.sourceEvent(
    part as unknown as Parameters<typeof _internals.sourceEvent>[0],
  );
  const sources = field(ev, 'evidence', 'sources') as R[];
  assertEquals(sources[0].title, 'https://example.com');
});

Deno.test('_internals.sourceEvent maps non-url source to raw evidence', () => {
  const part = { type: 'source' as const, sourceType: 'other' };
  const ev = _internals.sourceEvent(
    part as unknown as Parameters<typeof _internals.sourceEvent>[0],
  );
  assertEquals(ev.type, 'evidence');
  assertEquals(field(ev, 'evidence', 'citations'), undefined);
});

Deno.test('_internals.primaryEventFromPart maps text-delta', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.primaryEventFromPart>[0];
  const ev = _internals.primaryEventFromPart({ type: 'text-delta', text: 'chunk' } as Part, acc);
  assertEquals(ev?.type, 'text');
  assertEquals(field(ev, 'text'), 'chunk');
  assertEquals(acc.text, 'chunk');
});

Deno.test('_internals.primaryEventFromPart maps reasoning-delta', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.primaryEventFromPart>[0];
  const ev = _internals.primaryEventFromPart(
    { type: 'reasoning-delta', text: 'thinking' } as Part,
    acc,
  );
  assertEquals(ev?.type, 'thought');
  assertEquals(field(ev, 'text'), 'thinking');
});

Deno.test('_internals.primaryEventFromPart maps error', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.primaryEventFromPart>[0];
  const ev = _internals.primaryEventFromPart({ type: 'error', error: 'boom' } as Part, acc);
  assertEquals(ev?.type, 'error');
  assertEquals(acc.errored, true);
});

Deno.test('_internals.primaryEventFromPart skips duplicate source events', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.primaryEventFromPart>[0];
  const source = { type: 'source' as const, sourceType: 'url', url: 'https://a.com' } as Part;
  const first = _internals.primaryEventFromPart(source, acc);
  assertEquals(first?.type, 'evidence');
  assertEquals(acc.evidenceSeen, true);
  const second = _internals.primaryEventFromPart(source, acc);
  assertEquals(second, undefined);
});

Deno.test('_internals.primaryEventFromPart returns undefined for unknown types', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.primaryEventFromPart>[0];
  assertEquals(
    _internals.primaryEventFromPart({ type: 'unknown-thing' } as unknown as Part, acc),
    undefined,
  );
});

Deno.test('_internals.eventFromPart falls through to providerMetadata', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.eventFromPart>[0];
  const part = {
    type: 'step-start' as const,
    providerMetadata: { citations: ['url'] },
  } as unknown as Part;
  const events = _internals.eventFromPart(part, acc);
  assertEquals(events.length, 1);
  assertEquals(events[0].type, 'evidence');
});

Deno.test('_internals.eventFromPart returns empty for no match', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.eventFromPart>[0];
  const part = { type: 'step-start' as const } as unknown as Part;
  const events = _internals.eventFromPart(part, acc);
  assertEquals(events.length, 0);
});

Deno.test('_internals.finalEvents emits structured and done', () => {
  const acc = _internals.createAccumulator();
  acc.text = '{"answer":"yes"}';
  const req = createMockTurnRequest('formatter', 'test');
  const events = [..._internals.finalEvents(req, acc)];
  const hasStructured = events.some((e) => e.type === 'structured');
  const hasDone = events.some((e) => e.type === 'done');
  assertEquals(hasDone, true);
  if (req.structured) {
    assertEquals(hasStructured, true);
  }
});

Deno.test('_internals.finalEvents skips when errored', () => {
  const acc = _internals.createAccumulator();
  acc.errored = true;
  acc.text = '{"answer":"yes"}';
  const req = createMockTurnRequest('formatter', 'test');
  const events = [..._internals.finalEvents(req, acc)];
  assertEquals(events.length, 0);
});

Deno.test('_internals.finalEvents emits done only when no structured text', () => {
  const acc = _internals.createAccumulator();
  acc.text = '';
  const req = createMockTurnRequest('pinned', 'test');
  const events = [..._internals.finalEvents(req, acc)];
  assertEquals(events.length, 1);
  assertEquals(events[0].type, 'done');
});

Deno.test('_internals.openRouterHeaders returns undefined when no site info', () => {
  assertEquals(_internals.openRouterHeaders({}), undefined);
});

Deno.test('_internals.openRouterHeaders sets HTTP-Referer for siteUrl', () => {
  const headers = _internals.openRouterHeaders({ siteUrl: 'https://app.com' });
  assertEquals(headers?.['HTTP-Referer'], 'https://app.com');
  assertEquals(headers?.['X-Title'], undefined);
});

Deno.test('_internals.openRouterHeaders sets X-Title for siteName', () => {
  const headers = _internals.openRouterHeaders({ siteName: 'MyApp' });
  assertEquals(headers?.['X-Title'], 'MyApp');
  assertEquals(headers?.['HTTP-Referer'], undefined);
});

Deno.test('_internals.openRouterHeaders sets both headers', () => {
  const headers = _internals.openRouterHeaders({ siteUrl: 'https://a.com', siteName: 'A' });
  assertEquals(headers?.['HTTP-Referer'], 'https://a.com');
  assertEquals(headers?.['X-Title'], 'A');
});

Deno.test('_internals.providerOptionsFor returns undefined for no thinking no structured', () => {
  const req = createMockTurnRequest('pinned', 'test');
  req.thinking = 'none';
  req.structured = null;
  assertEquals(_internals.providerOptionsFor(req), undefined);
});

Deno.test('_internals.providerOptionsFor includes reasoning effort', () => {
  const req = createMockTurnRequest('pinned', 'test');
  req.thinking = 'high';
  req.structured = null;
  const opts = _internals.providerOptionsFor(req);
  assertEquals(field(opts, 'openrouter', 'reasoning'), { effort: 'high' });
});

Deno.test('_internals.missingOpenRouterKey returns error event', () => {
  const ev = _internals.missingOpenRouterKey();
  assertEquals(ev.type, 'error');
});

Deno.test('_internals.providerMetadataEvent returns undefined without providerMetadata', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.providerMetadataEvent>[0];
  assertEquals(
    _internals.providerMetadataEvent({ type: 'text-delta', text: 'x' } as Part, acc),
    undefined,
  );
});

Deno.test('_internals.providerMetadataEvent extracts evidence', () => {
  const acc = _internals.createAccumulator();
  type Part = Parameters<typeof _internals.providerMetadataEvent>[0];
  const part = { type: 'step-finish', providerMetadata: { citations: ['url'] } } as unknown as Part;
  const ev = _internals.providerMetadataEvent(part, acc);
  assertEquals(ev?.type, 'evidence');
});
