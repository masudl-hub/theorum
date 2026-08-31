import '../fixtures/enable-test-internals.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type {
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
} from '../../src/kernel/types.ts';
import { createLocalProvider, DEFAULT_LOCAL_BASE_URL } from '../../src/providers/local.ts';
import { testInternals } from '../fixtures/testInternals.js';

const internals = testInternals('local');

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function baseReq(overrides: Partial<ProviderCompleteRequest> = {}): ProviderCompleteRequest {
  return {
    model: 'local-model',
    apiId: 'llama3.2',
    thinking: 'none',
    summaries: 'none',
    maxOutputTokens: 256,
    temperature: 0.2,
    builtins: [],
    system: 'Be brief.',
    input: [{ type: 'text', text: 'Hello' }],
    structured: null,
    image: null,
    ...overrides,
  };
}

Deno.test('resolveBaseUrl defaults to loopback Ollama port', () => {
  assertEquals(internals.resolveBaseUrl(), DEFAULT_LOCAL_BASE_URL);
  assertEquals(internals.resolveBaseUrl({}), DEFAULT_LOCAL_BASE_URL);
  assertEquals(
    internals.resolveBaseUrl({ baseUrl: 'http://localhost:8080/' }),
    'http://localhost:8080',
  );
  assertEquals(
    internals.resolveBaseUrl({ baseUrl: '  http://10.0.0.2:1234  ' }),
    'http://10.0.0.2:1234',
  );
});

Deno.test('resolveBaseUrl does not read OLLAMA_HOST', () => {
  const prev = Deno.env.get('OLLAMA_HOST');
  try {
    Deno.env.set('OLLAMA_HOST', 'http://env-should-not-win:9999');
    assertEquals(internals.resolveBaseUrl(), DEFAULT_LOCAL_BASE_URL);
    assertEquals(
      internals.resolveBaseUrl({ baseUrl: 'http://explicit:11434' }),
      'http://explicit:11434',
    );
  } finally {
    if (prev === undefined) Deno.env.delete('OLLAMA_HOST');
    else Deno.env.set('OLLAMA_HOST', prev);
  }
});

Deno.test('historyToWire maps history parts including images', () => {
  const msgs = internals.historyToWire(
    baseReq({
      history: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', data: 'abc' },
          ],
        } satisfies TurnHistoryMessage,
        { role: 'assistant', content: 'nice' },
      ],
      input: [{ type: 'text', text: 'again' }],
    }),
  );
  assertEquals(msgs[0], { role: 'system', content: 'Be brief.' });
  assertEquals(msgs[1].role, 'user');
  assertEquals(Array.isArray(msgs[1].content), true);
  assertEquals(msgs[1].content[0], { type: 'text', text: 'look' });
  assertEquals(msgs[1].content[1].type, 'image_url');
  assertEquals(msgs[1].content[1].image_url.url, 'data:image/png;base64,abc');
  assertEquals(msgs[2], { role: 'assistant', content: 'nice' });
  assertEquals(msgs[3], { role: 'user', content: 'again' });
});

Deno.test('historyToWire preserves tool call exchanges', () => {
  const msgs = internals.historyToWire(
    baseReq({
      history: [
        {
          role: 'assistant',
          content: null as unknown as string,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":1}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'lookup',
          content: '{"ok":true}',
        },
      ],
      input: [{ type: 'text', text: 'next' }],
    }),
  );
  assertEquals(msgs[1].tool_calls?.[0].function.name, 'lookup');
  assertEquals(msgs[2], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'lookup',
    content: '{"ok":true}',
  });
});

Deno.test('toolsToWire maps dynamic tools only', () => {
  assertEquals(internals.toolsToWire(undefined), undefined);
  assertEquals(internals.toolsToWire([]), undefined);
  assertEquals(
    internals.toolsToWire([
      {
        name: 'ping',
        description: 'Ping',
        parameters: { type: 'object', properties: {} },
      },
    ]),
    [
      {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Ping',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  );
});

Deno.test('createLocalProvider streams text, tokens, and completed stop', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5},"choices":[]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const events = await collect(provider.complete(baseReq()));
  assertEquals(calls[0].url, 'http://local.test/v1/chat/completions');
  assertEquals(calls[0].body.model, 'llama3.2');
  assertEquals(calls[0].body.stream, true);
  assertEquals(
    events.filter((e) => e.type === 'text').map((e) => e.text),
    ['Hi', '!'],
  );
  assertEquals(events.find((e) => e.type === 'tokens')?.tokens, {
    input: 3,
    output: 2,
    total: 5,
  });
  const done = events.find((e) => e.type === 'done');
  assertEquals(done?.stop?.kind, 'completed');
  assertEquals(done?.stop?.native, 'stop');
});

Deno.test('createLocalProvider maps finish_reason length and tool_calls', async () => {
  const lengthProvider = createLocalProvider({
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const lengthEvents = await collect(lengthProvider.complete(baseReq()));
  assertEquals(lengthEvents.find((e) => e.type === 'done')?.stop?.kind, 'length');

  const toolProvider = createLocalProvider({
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ping","arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const toolEvents = await collect(
    toolProvider.complete(
      baseReq({
        dynamicTools: [
          { name: 'ping', description: '', parameters: { type: 'object', properties: {} } },
        ],
      }),
    ),
  );
  const tool = toolEvents.find((e) => e.type === 'tool');
  assertEquals(tool?.tool?.name, 'ping');
  assertEquals(tool?.tool?.arguments, { x: 1 });
  assertEquals(tool?.tool?.id, 'c1');
  assertEquals(toolEvents.find((e) => e.type === 'done')?.stop?.kind, 'tool');
});

Deno.test('createLocalProvider yields error event on HTTP failure', async () => {
  const provider = createLocalProvider({
    fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
  });
  const events = await collect(provider.complete(baseReq()));
  assertEquals(events.length, 1);
  assertEquals(events[0].type, 'error');
  assertEquals(String(events[0].errorInternal ?? '').includes('503'), true);
});

Deno.test('createLocalProvider reads finish_reason when delta is absent', async () => {
  const provider = createLocalProvider({
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const events = await collect(provider.complete(baseReq()));
  assertEquals(events.find((e) => e.type === 'done')?.stop?.kind, 'completed');
});
