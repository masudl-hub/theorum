import { standardEgressEnforce } from '../../src/guardrails/egress.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { mintCanary } from '../../src/kernel/engine/boundary.ts';
import type { Profile } from '../../src/kernel/types.ts';

function liveProfile(egress = true): Profile {
  return {
    id: 'live.test',
    identity: { handle: 'live' },
    outputs: {},
    model: {
      protocol: 'geminiLive',
      provider: 'google',
      allow: ['m'],
      config: {
        m: {
          apiId: 'gemini-live',
          thinking: { on: 'none', off: 'none' },
          thinkingLevels: ['none'],
          summaries: { on: 'none', off: 'none' },
          maxOutputTokens: 256,
          temperature: 0,
          builtInTools: [],
        },
      },
    },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: {
      canary: true,
      egress: egress
        ? {
            onBlock: 'refuse_to_user',
            enforce: standardEgressEnforce,
          }
        : undefined,
    },
  };
}

Deno.test('processLiveOutboundBatch holds text until finalize when egress enforce is set', async () => {
  const canary = mintCanary();
  const session = createLiveOutboundGateSession(liveProfile(true), canary);

  const batch = processLiveOutboundBatch(session, [{ type: 'text', text: 'Hello there.' }]);
  assertEquals(batch.action, 'idle');

  const done = await finalizeLiveOutboundTurn(session);
  assertEquals(done.action, 'emit');
  if (done.action === 'emit') {
    assertEquals(done.events[0]?.text, 'Hello there.');
  }
});

Deno.test('finalizeLiveOutboundTurn withholds canary leaks under egress enforce', async () => {
  const canary = mintCanary();
  const session = createLiveOutboundGateSession(liveProfile(true), canary);

  const batch = processLiveOutboundBatch(session, [{ type: 'text', text: `Leak: ${canary}` }]);
  const done = await finalizeLiveOutboundTurn(session);
  const withheld = batch.action === 'withhold' || done.action === 'withhold';
  assertEquals(withheld, true);
});

Deno.test('processLiveOutboundBatch detects split canary without egress hold', () => {
  const canary = mintCanary();
  const session = createLiveOutboundGateSession(liveProfile(false), canary);
  const half = Math.ceil(canary.length / 2);

  const first = processLiveOutboundBatch(session, [{ type: 'text', text: canary.slice(0, half) }]);
  assertEquals(first.action, 'idle');

  const second = processLiveOutboundBatch(session, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(second.action, 'withhold');
});

Deno.test('abortLiveOutboundTurn clears held assistant text on interrupt', async () => {
  const canary = mintCanary();
  const session = createLiveOutboundGateSession(liveProfile(true), canary);
  processLiveOutboundBatch(session, [{ type: 'text', text: 'partial' }]);
  abortLiveOutboundTurn(session);
  const done = await finalizeLiveOutboundTurn(session);
  assertEquals(done.action, 'idle');
});

Deno.test('processLiveOutboundBatch streams media immediately under egress hold', () => {
  const session = createLiveOutboundGateSession(liveProfile(true), mintCanary());
  const result = processLiveOutboundBatch(session, [
    {
      type: 'media',
      media: { mimeType: 'audio/wav', data: 'AAAA' },
    },
  ]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.type, 'media');
  }
});
