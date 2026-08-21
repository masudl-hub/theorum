import '../fixtures/test-host.ts';
import { PUBLIC_UNAVAILABLE } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import {
  createOpenRouterProvider,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from '../../src/providers/openrouter.ts';

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
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'Orchid system prompt',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  };
}

Deno.test('resolveOpenRouterModel maps known models and accepts custom map', () => {
  assertEquals(resolveOpenRouterModel('gemini35FlashLite'), 'google/gemini-3.5-flash-lite');
  assertEquals(resolveOpenRouterModel('gemini37Flash'), 'google/gemini-3.7-flash');
  assertEquals(
    resolveOpenRouterModel('gemini35FlashLite', {
      gemini35FlashLite: 'anthropic/claude-3.7-sonnet',
    }),
    'anthropic/claude-3.7-sonnet',
  );
  assertEquals(resolveOpenRouterModel('perplexity/sonar'), 'perplexity/sonar');
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
    { role: 'user', content: 'What plants do I have?' },
    { role: 'assistant', content: 'You have a Monstera deliciosa.' },
  ];
  req.dynamicTools = [
    {
      name: 'ground_plant_knowledge',
      description: 'Fetch botanical guidance',
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
  assertMessage(messages[0], 'system', 'Orchid system prompt');
  assertMessage(messages[1], 'system', '[meta] ago=5m speaker=masud');
  assertMessage(messages[2], 'user', 'What plants do I have?');
  assertMessage(messages[3], 'assistant', 'You have a Monstera deliciosa.');
  assertMessage(messages[4], 'user');

  const tools = payload.tools as Record<string, unknown>[];
  assertEquals(tools.length, 1);
  const fn = tools[0]?.function as Record<string, unknown>;
  assertEquals(fn?.name, 'ground_plant_knowledge');
});

Deno.test('toOpenRouterPayload formats structured json_schema response_format', () => {
  const { generation } = resolveTurn({
    profile: 'designer',
    input: { text: 'Design hero card', slots: { language: 'html' } },
  });

  const req: ProviderCompleteRequest = {
    model: generation.model,
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
  const t1 = JSON.stringify({ choices: [{ delta: { reasoning: 'checking ' } }] });
  const t2 = JSON.stringify({ choices: [{ delta: { reasoning: 'database.' } }] });
  const c1 = JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] });
  const c2 = JSON.stringify({ choices: [{ delta: { content: 'world.' } }] });
  const tc1 = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } },
          ],
        },
      },
    ],
  });
  const tc2 = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"monstera"}' } }] } }],
  });
  const u = JSON.stringify({
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
    `data: ${tc2}\n\n`,
    `data: ${u}\n\n`,
    'data: [DONE]\n\n',
  ];
}

Deno.test('createOpenRouterProvider streams reasoning, text, tools, tokens, and done', async () => {
  const mockSse = mockStreamChunks();
  let fetchCalledWith = '';

  const provider = createOpenRouterProvider({
    apiKey: 'mock-auth-token',
    fetch: (url, init) => {
      fetchCalledWith = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization;
      assertEquals(auth, 'Bearer mock-auth-token');
      return Promise.resolve(sseResponse(mockSse));
    },
  });

  const req = createMockTurnRequest('pinned', 'How often to water?');
  const events = await collect(provider.complete(req));

  assertEquals(fetchCalledWith, 'https://openrouter.ai/api/v1/chat/completions');

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
  assertEquals(toolEvents[0]?.tool?.arguments, { q: 'monstera' });

  const tokenEvents = events.filter((e) => e.type === 'tokens');
  assertEquals(tokenEvents.length, 1);
  assertEquals(tokenEvents[0]?.tokens?.input, EXPECTED_INPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.output, EXPECTED_OUTPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.total, EXPECTED_TOTAL_TOKENS);
  assertEquals(events.filter((e) => e.type === 'done').length, 1);
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
