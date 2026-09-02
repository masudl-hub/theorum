import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { PUBLIC_CANARY } from '../../src/guardrails/error.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { EgressContext, EgressEnforcementResult, TurnEvent } from '../../src/kernel/types.ts';
import { modelAllow } from '../fixtures/models.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function chatProfile() {
  return getProfile('chat');
}

function session(canary?: string) {
  return createLiveOutboundGateSession(chatProfile(), canary);
}

function textEvents(texts: string[]): TurnEvent[] {
  return texts.map((text) => ({ type: 'text' as const, text }));
}

// ── createLiveOutboundGateSession ─────────────────────────────────────────────

Deno.test('createLiveOutboundGateSession: canary gate is null when no canary supplied', () => {
  const s = session();
  assertEquals(s.gate, null);
  assertEquals(s.canary, undefined);
});

Deno.test('createLiveOutboundGateSession: gate is created when canary is supplied', () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.canary, canary);
  assertEquals(s.gate !== null, true);
});

Deno.test('createLiveOutboundGateSession: holdUserVisible is false when egress has no enforce', () => {
  assertEquals(session(mintCanary()).holdUserVisible, false);
});

// ── processLiveOutboundBatch — basic streaming ────────────────────────────────

Deno.test('processLiveOutboundBatch emits safe text chunks without a canary gate', () => {
  const s = session();
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.text, 'hello');
  }
});

Deno.test('processLiveOutboundBatch emits safe long text chunk through the gate', () => {
  const canary = mintCanary();
  const s = session(canary);
  const longText = 'safe text '.repeat(20);
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: longText }]);
  // gate may buffer the tail (overlap window) but should emit something
  assertEquals(result.action === 'emit' || result.action === 'idle', true);
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a stream event', () => {
  const canary = mintCanary();
  const s = session(canary);
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: canary }]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a non-stream event', () => {
  const canary = mintCanary();
  const s = session(canary);
  const events: TurnEvent[] = [{ type: 'error', error: canary }];
  const result = processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch passes non-stream events without canary', () => {
  const s = session(mintCanary());
  const result = processLiveOutboundBatch(s, [{ type: 'done' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.type, 'done');
  }
});

Deno.test('processLiveOutboundBatch returns idle for empty event list', () => {
  const s = session(mintCanary());
  assertEquals(processLiveOutboundBatch(s, []).action, 'idle');
});

Deno.test('processLiveOutboundBatch flushes canary tail on stream-type transition', () => {
  const canary = mintCanary();
  const s = session(canary);
  // Send a text event first, then a thought event — triggers type-switch flush
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = processLiveOutboundBatch(s, [{ type: 'thought', text: 'thinking' }]);
  // Should emit or idle but not withhold
  assertEquals(result.action !== 'withhold', true);
});

Deno.test('processLiveOutboundBatch withholds when non-stream event follows a pending gate tail with canary', () => {
  const canary = mintCanary();
  const s = session(canary);
  // seed the gate with the beginning of the canary so there's a pending tail
  processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, 5) }]);
  // Now the gate has 'lastStreamType' set; force a flush by sending a non-stream event
  // while also completing the canary in the pending buffer by sending the rest
  const events: TurnEvent[] = [
    { type: 'text', text: canary.slice(5) },
    { type: 'done' },
  ];
  const result = processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

// ── processLiveOutboundBatch — holdUserVisible (egress.enforce) ───────────────

Deno.test('processLiveOutboundBatch buffers visible events when holdUserVisible is true', async () => {
  let enforced = false;
  registerProfile(
    defineProfile({
      id: 'live_egress_hold',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: async (ctx: EgressContext): Promise<EgressEnforcementResult> => {
            enforced = true;
            return { blocked: false, text: ctx.text };
          },
        },
      },
    }),
  );
  const profile = getProfile('live_egress_hold');
  // No canary — gate is null, so text goes directly into the egress hold buffer
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.holdUserVisible, true);

  // Events should be buffered, not emitted
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'answer' }]);
  assertEquals(result.action, 'idle');
  assertEquals(s.pendingVisible.length > 0, true);
  assertEquals(enforced, false);

  // Finalize releases them
  const final = await finalizeLiveOutboundTurn(s);
  assertEquals(enforced, true);
  assertEquals(final.action, 'emit');
});

Deno.test('finalizeLiveOutboundTurn withholds when egress.enforce blocks', async () => {
  registerProfile(
    defineProfile({
      id: 'live_egress_block',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: async (_ctx: EgressContext): Promise<EgressEnforcementResult> => ({
            blocked: true,
            text: '',
            hits: ['injection_echo'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_block');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user text when onBlock is set', async () => {
  registerProfile(
    defineProfile({
      id: 'live_egress_refuse',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          onBlock: 'refuse_to_user',
          enforce: async (_ctx: EgressContext): Promise<EgressEnforcementResult> => ({
            blocked: true,
            text: 'That reply was blocked.',
            hits: ['canary'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_refuse');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.text, 'That reply was blocked.');
  }
});

// ── finalizeLiveOutboundTurn — no egress hold ─────────────────────────────────

Deno.test('finalizeLiveOutboundTurn flushes canary gate tail on finalize', async () => {
  const canary = mintCanary();
  const s = session(canary);
  // feed most of a long string so the tail is buffered
  processLiveOutboundBatch(s, [{ type: 'text', text: 'prefix ' }]);
  const result = await finalizeLiveOutboundTurn(s);
  // tail should be flushed and emitted
  assertEquals(result.action === 'emit' || result.action === 'idle', true);
});

Deno.test('finalizeLiveOutboundTurn returns idle when there is nothing to emit', async () => {
  const s = session(mintCanary());
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('finalizeLiveOutboundTurn withholds when flushed canary tail leaks', async () => {
  const canary = mintCanary();
  const s = session(canary);
  // fill the gate's pending buffer with the whole canary by splitting it
  const half = Math.ceil(canary.length / 2);
  processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  // send the second half — gate detects the leak
  const result2 = processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result2.action, 'withhold');
});

// ── abortLiveOutboundTurn ────────────────────────────────────────────────────

Deno.test('abortLiveOutboundTurn clears accumulated state and resets the gate', () => {
  const canary = mintCanary();
  const s = session(canary);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'partial answer' }]);
  s.accumulatedText = 'partial answer';
  abortLiveOutboundTurn(s);
  assertEquals(s.pendingVisible.length, 0);
  assertEquals(s.accumulatedText, '');
  assertEquals(s.lastStreamType, undefined);
  assertEquals(s.gate !== null, true);
});

Deno.test('abortLiveOutboundTurn without canary does not recreate gate', () => {
  const s = session();
  abortLiveOutboundTurn(s);
  assertEquals(s.gate, null);
});
