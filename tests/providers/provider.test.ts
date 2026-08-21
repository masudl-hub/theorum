import '../fixtures/test-host.ts';
import { PUBLIC_UNAVAILABLE } from '../../src/guardrails/error.ts';
import type { GeminiVault } from '../../src/guardrails/keys.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/interactions.ts';
import { createInteractionsProvider } from '../../src/providers/provider.ts';
import { INTERACTIONS_URL } from '../../src/providers/sse.ts';

const vault: GeminiVault = {
  studio: 'studio-key',
  portfolio: 'portfolio-key',
  planner: 'planner-key',
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

function fromMermaid(): ProviderCompleteRequest {
  const { generation } = resolveTurn({ profile: 'chat', input: { text: 'hi' } });
  return {
    model: generation.model,
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

Deno.test('mermaid Interactions body streams JSON schema and never ships geminiBucket', () => {
  const req = fromMermaid();
  const body = toInteractionsBody(req);
  const format = body[camelToSnake('responseFormat')] as unknown[];
  const config = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.stream, true);
  assertEquals(body.store, false);
  assertEquals(body.model, 'gemini-3.5-flash-lite');
  assertEquals(config[camelToSnake('maxOutputTokens')], req.maxOutputTokens);
  assertEquals(Array.isArray(format), true);
  assertEquals(Object.hasOwn(body, camelToSnake('geminiBucket')), false);
  assertEquals(Object.hasOwn(body, 'geminiBucket'), false);
  assertEquals(Object.hasOwn(body, camelToSnake('previousInteractionId')), false);
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
  const req = fromMermaid();
  req.history = [
    { role: 'user', content: 'What is plant care?' },
    { role: 'assistant', content: 'It is nurturing plants.' },
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
  assertEquals(input[0]?.content[0]?.text, 'What is plant care?');
  assertEquals(input[1]?.type, 'model_turn');
  assertEquals(input[1]?.content[0]?.text, 'It is nurturing plants.');
  assertEquals(input[2]?.type, 'user_input');
  assertEquals(input[2]?.content[0]?.text, 'Check this image');
  assertEquals(input[2]?.content[1]?.mime_type, 'image/png');
  assertEquals(input[3]?.type, 'user_input');
  assertEquals(input[3]?.content[0]?.text, '<user_data>\nhi\n</user_data>');
});

Deno.test('JSON Schema property names stay camelCase inside response_format.schema', () => {
  const { generation } = resolveTurn({
    profile: 'designer',
    input: { text: 'x', slots: { language: 'html' } },
  });
  const body = toInteractionsBody({
    model: generation.model,
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

Deno.test('planner prompt-enforced schema omits JSON response_format', () => {
  const { generation } = resolveTurn({
    profile: 'picker',
    select: 'fast',
    input: { text: 'x' },
  });
  const body = toInteractionsBody({
    model: generation.model,
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
  const events = await collect(provider.complete(fromMermaid()));
  assertEquals(href, INTERACTIONS_URL);
  assertEquals(used, ['portfolio-key']);
  assertEquals(events, [
    { type: 'thought', text: 'hmm' },
    { type: 'text', text: '{"message":"ok"}' },
    { type: 'structured', structured: { message: 'ok' } },
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
  const events = await collect(provider.complete(fromMermaid()));
  assertEquals(used, ['portfolio-key', 'portfolio-key', 'portfolio-key', 'paid-key']);
  assertEquals(events[0], { type: 'text', text: 'hi' });
});

Deno.test('non-OK Gemini response becomes an error event', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.resolve(new Response('nope', { status: HTTP_SERVER })),
  });
  const events = await collect(provider.complete(fromMermaid()));
  assertEquals(events, [{ type: 'error', error: PUBLIC_UNAVAILABLE }]);
});

Deno.test('thrown fetch errors become upstream failed', async () => {
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () => Promise.reject(new TypeError('fetch failed: dns')),
  });
  const events = await collect(provider.complete(fromMermaid()));
  assertEquals(events, [{ type: 'error', error: PUBLIC_UNAVAILABLE }]);
});

Deno.test('image delta yields media', async () => {
  const { generation } = resolveTurn({ profile: 'image', input: { text: 'fox' } });
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
  assertEquals(events, [{ type: 'media', media: { mimeType: 'image/png', data: 'abc' } }]);
});

Deno.test('interaction complete yields output_image media', async () => {
  const { generation } = resolveTurn({ profile: 'image', input: { text: 'fox' } });
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
  assertEquals(events, [{ type: 'media', media: { mimeType: 'image/png', data: 'xyz' } }]);
});

Deno.test('interaction complete yields outputs image media', async () => {
  const { generation } = resolveTurn({ profile: 'image', input: { text: 'fox' } });
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
  assertEquals(events, [{ type: 'media', media: { mimeType: 'image/png', data: 'out' } }]);
});
