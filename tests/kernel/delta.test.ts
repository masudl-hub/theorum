import { assertEquals, assertExists } from '@std/assert';
import {
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  extractUsageTokens,
  groundingFromEvent,
  tryStructured,
} from '../../src/kernel/engine/delta.ts';
import type { GroundingSource } from '../../src/kernel/types.ts';

Deno.test('delta.ts: eventsFromDelta extracts thought, text, image, and fallback', () => {
  // thought
  assertEquals(eventsFromDelta({ type: 'thought', text: 'thinking...' }), [
    { type: 'thought', text: 'thinking...' },
  ]);
  assertEquals(eventsFromDelta({ type: 'thought_summary', content: 'summary thought' }), [
    { type: 'thought', text: 'summary thought' },
  ]);
  assertEquals(eventsFromDelta({ type: 'thought', content: { text: 'nested thought' } }), [
    { type: 'thought', text: 'nested thought' },
  ]);

  // text
  assertEquals(eventsFromDelta({ type: 'text', text: 'hello text' }), [
    { type: 'text', text: 'hello text' },
  ]);
  assertEquals(eventsFromDelta({ type: 'text', text: '' }), []);

  // image
  assertEquals(eventsFromDelta({ type: 'image', mimeType: 'image/png', data: 'abc' }), [
    { type: 'media', media: { mimeType: 'image/png', data: 'abc' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'image', mime_type: 'image/jpeg', data: 'xyz' }), [
    { type: 'media', media: { mimeType: 'image/jpeg', data: 'xyz' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'image', mimeType: 'image/png' }), []);

  // unknown delta
  assertEquals(eventsFromDelta({ type: 'unknown_type' }), []);
  assertEquals(eventsFromDelta(null), []);
});

Deno.test('delta.ts: groundingFromEvent parses web, maps, rendered HTML, and nested step sources', () => {
  const event = {
    interaction: {
      id: 'inter_123',
      grounding_metadata: {
        grounding_chunks: [
          {
            web: { uri: 'https://example.com/docs', title: 'Example Docs' },
          },
          {
            web: { uri: 'https://foo.bar', domain: 'foo.bar' },
          },
          {
            maps: { google_maps_uri: 'https://maps.google.com/?q=cafe', name: 'Cool Cafe' },
          },
          {
            maps: { uri: 'https://maps.google.com/?q=park' },
          },
          null,
        ],
        search_entry_point: {
          rendered_content: '<div>Search widget</div>',
        },
      },
      steps: [
        {
          groundingMetadata: {
            groundingChunks: [
              {
                web: { uri: 'https://example.com/docs' }, // duplicate uri
              },
            ],
          },
          content: [
            {
              groundingMetadata: {
                groundingChunks: [
                  {
                    web: { uri: 'https://substep.org', title: 'Substep' },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };

  const groundingEv = groundingFromEvent(event);
  assertExists(groundingEv);
  assertExists(groundingEv.grounding);
  assertEquals(groundingEv.type, 'grounding');
  assertEquals(groundingEv.grounding.searchHtml, '<div>Search widget</div>');
  assertGroundingSources(groundingEv.grounding.sources);
});

function assertGroundingSources(sources: GroundingSource[]): void {
  const [first, second, third, fourth, fifth] = sources;
  assertExists(first);
  assertExists(second);
  assertExists(third);
  assertExists(fourth);
  assertExists(fifth);
  assertEquals(sources.length, 5);
  assertEquals(first.title, 'Example Docs');
  assertEquals(second.title, 'foo.bar');
  assertEquals(third.type, 'maps');
  assertEquals(third.title, 'Cool Cafe');
  assertEquals(fourth.type, 'maps');
  assertEquals(fourth.title, 'https://maps.google.com/?q=park');
  assertEquals(fifth.uri, 'https://substep.org');
}

Deno.test('delta.ts: extractUsageTokens and extractTokenEvent support all token naming variations', () => {
  assertEquals(extractUsageTokens(null), undefined);
  assertEquals(extractUsageTokens({}), undefined);

  const snakeUsage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    thoughts_tokens: 20,
    tool_tokens: 10,
    total_tokens: 180,
  };
  assertEquals(extractUsageTokens(snakeUsage), {
    input: 100,
    output: 50,
    thinking: 20,
    toolUse: 10,
    total: 180,
  });

  const camelUsage = {
    inputTokens: 50,
    outputTokens: 25,
    thinkingTokens: 10,
    toolTokens: 5,
  };
  assertEquals(extractUsageTokens(camelUsage), {
    input: 50,
    output: 25,
    thinking: 10,
    toolUse: 5,
    total: 90, // calculated sum
  });

  const eventWithUsage = {
    interaction: {
      id: 'int_abc',
      usageMetadata: {
        totalInputTokens: 20,
        totalOutputTokens: 10,
      },
    },
  };
  const tokenEvent = extractTokenEvent(eventWithUsage);
  assertEquals(tokenEvent?.type, 'tokens');
  assertEquals(tokenEvent?.tokens?.input, 20);
  assertEquals(tokenEvent?.tokens?.output, 10);
  assertEquals(tokenEvent?.interactionId, 'int_abc');
});

Deno.test('delta.ts: eventsFromComplete parses outputs array, direct output_image, and tryStructured', () => {
  const completeWithOutputs = {
    interaction: {
      output_text: 'Done here',
      outputs: [{ type: 'other' }, { type: 'image', mimeType: 'image/png', data: 'img_bytes' }],
      usage: { input: 10, output: 20 },
    },
  };
  const events1 = eventsFromComplete(completeWithOutputs, false);
  assertEquals(
    events1.map((e) => e.type),
    ['text', 'media', 'tokens'],
  );

  // Already text emitted -> output_text skipped
  const events2 = eventsFromComplete(completeWithOutputs, true);
  assertEquals(
    events2.map((e) => e.type),
    ['media', 'tokens'],
  );

  // Direct output_image
  const directImageEvent = {
    output_image: { mimeType: 'image/jpeg', data: 'direct_bytes' },
  };
  const events3 = eventsFromComplete(directImageEvent, true);
  assertEquals(events3[0]?.type, 'media');

  // tryStructured
  assertEquals(tryStructured('{"status":"ok"}')?.structured, { status: 'ok' });
  assertEquals(tryStructured('not json'), undefined);
});
