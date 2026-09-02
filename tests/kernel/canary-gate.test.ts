import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { mintCanary } from '../../src/kernel/engine/boundary.ts';
import {
  createCanaryGateSession,
  filterCanaryGatedEvents,
} from '../../src/kernel/engine/canary-gate.ts';

Deno.test('filterCanaryGatedEvents detects split canary across live batches', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  const half = Math.ceil(canary.length / 2);

  const first = filterCanaryGatedEvents(session, [{ type: 'text', text: canary.slice(0, half) }]);
  assertEquals(first.leaked, false);
  if (!first.leaked) {
    assertEquals(first.events.length, 0);
  }

  const second = filterCanaryGatedEvents(session, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(second.leaked, true);
});

Deno.test('filterCanaryGatedEvents passes safe events through', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  const safeText = `${'hello world '.repeat(5)}done`;
  const filtered = filterCanaryGatedEvents(session, [{ type: 'text', text: safeText }]);
  assertEquals(filtered.leaked, false);
  if (!filtered.leaked) {
    assertEquals(filtered.events.length, 1);
    assertEquals(filtered.events[0]?.text?.startsWith('hello world'), true);
    assertEquals(filtered.events[0]?.text?.includes(canary), false);
    const tail = session.gate.flush();
    assertEquals(tail.leak, false);
    if (!tail.leak) {
      assertEquals(tail.emit.endsWith('done'), true);
    }
  }
});
