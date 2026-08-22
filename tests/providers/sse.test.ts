import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { takeSsePayloads } from '../../src/providers/sse.ts';

Deno.test('takeSsePayloads keeps event names, thought signatures, and [DONE]', () => {
  const raw = [
    'event: interaction.created',
    'data: {"event_type":"interaction.created","interaction":{"id":"","status":"in_progress"}}',
    '',
    'event: step.delta',
    'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"abc"}}',
    '',
    'event: done',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const { payloads, pendingEvent } = takeSsePayloads(raw);
  assertEquals(pendingEvent, '');
  assertEquals(payloads[0]?.sseEvent, 'interaction.created');
  assertEquals(payloads[0]?.event_type, 'interaction.created');
  const delta = payloads[1]?.delta as Record<string, unknown>;
  assertEquals(delta.signature, 'abc');
  assertEquals(payloads[2]?.eventType, 'sse_done');
  assertEquals(payloads[2]?.sseEvent, 'done');
});

Deno.test('takeSsePayloads carries event name across chunks', () => {
  const first = takeSsePayloads('event: step.start\n');
  assertEquals(first.payloads, []);
  const second = takeSsePayloads(
    'data: {"event_type":"step.start","index":0}\n',
    first.pendingEvent,
  );
  assertEquals(second.payloads[0]?.sseEvent, 'step.start');
  assertEquals(second.payloads[0]?.index, 0);
});

Deno.test('takeSsePayloads handles empty data, non-object JSON, and invalid JSON gracefully', () => {
  const raw = [
    'event: empty_ev',
    'data: ',
    'event: array_ev',
    'data: [1, 2, 3]',
    'event: primitive_ev',
    'data: 42',
    'event: bad_json',
    'data: { invalid syntax',
    '',
  ].join('\n');

  const { payloads } = takeSsePayloads(raw);
  assertEquals(payloads.length, 4);

  // Empty data
  assertEquals(payloads[0].sseEvent, 'empty_ev');
  assertEquals(payloads[0].eventType, 'sse_done');

  // Array data (non-object)
  assertEquals(payloads[1].sseEvent, 'array_ev');
  assertEquals(payloads[1].eventType, 'sse_unparsed');
  assertEquals(payloads[1].data, [1, 2, 3]);

  // Primitive number
  assertEquals(payloads[2].sseEvent, 'primitive_ev');
  assertEquals(payloads[2].eventType, 'sse_unparsed');
  assertEquals(payloads[2].data, 42);

  // Invalid JSON string
  assertEquals(payloads[3].sseEvent, 'bad_json');
  assertEquals(payloads[3].eventType, 'sse_unparsed');
  assertEquals(payloads[3].data, '{ invalid syntax');
});
