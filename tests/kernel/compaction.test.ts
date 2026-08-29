import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { assertThrows } from '@std/assert';
import {
  compactionNeeded,
  splitForCompaction,
} from '../../src/kernel/engine/compaction.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import {
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import type {
  CompactionSpec,
  ModelProvider,
  TurnEvent,
  TurnHistoryMessage,
} from '../../src/kernel/types.ts';
import { modelAllow } from '../fixtures/models.ts';

function msg(role: TurnHistoryMessage['role'], content: string): TurnHistoryMessage {
  return { role, content };
}

function exchange(userText: string, assistantText: string): TurnHistoryMessage[] {
  return [msg('user', userText), msg('assistant', assistantText)];
}

const DEFAULT_SPEC: CompactionSpec = {
  maxHistoryTokens: 100_000,
  compactAt: 0.75,
  previousExchanges: 3,
  profile: 'test.compactor',
  timing: 'before',
};

// --- compactionNeeded ---

Deno.test('compactionNeeded returns true when tokens exceed threshold', () => {
  assertEquals(compactionNeeded(80_000, DEFAULT_SPEC), true);
});

Deno.test('compactionNeeded returns false when tokens are under threshold', () => {
  assertEquals(compactionNeeded(50_000, DEFAULT_SPEC), false);
});

Deno.test('compactionNeeded returns false at exact threshold', () => {
  assertEquals(compactionNeeded(75_000, DEFAULT_SPEC), false);
});

// --- splitForCompaction with exchange count ---

Deno.test('splitForCompaction retains last N exchanges by count', () => {
  const history = [
    ...exchange('hello', 'hi'),
    ...exchange('how are you', 'fine'),
    ...exchange('topic A', 'answer A'),
    ...exchange('topic B', 'answer B'),
    ...exchange('topic C', 'answer C'),
  ];

  const result = splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 3 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 6);
  assertEquals(result.toRetain[0].content, 'topic A');
});

Deno.test('splitForCompaction retains all when fewer exchanges than requested', () => {
  const history = [...exchange('hello', 'hi'), ...exchange('bye', 'later')];
  const result = splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 5 });
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 4);
});

// --- splitForCompaction with zero (compact all) ---

Deno.test('splitForCompaction compacts everything when previousExchanges is 0', () => {
  const history = [...exchange('a', 'b'), ...exchange('c', 'd')];
  const result = splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 0 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 0);
});

// --- splitForCompaction with fraction ---

Deno.test('splitForCompaction retains exchanges within token budget fraction', () => {
  const shortExchange = exchange('hi', 'hello');
  const longExchange = exchange('x'.repeat(2000), 'y'.repeat(2000));
  const history = [...longExchange, ...shortExchange, ...shortExchange];

  const result = splitForCompaction(history, {
    ...DEFAULT_SPEC,
    previousExchanges: 0.5,
    maxHistoryTokens: 100,
  });

  assertEquals(result.toRetain.length, 4);
  assertEquals(result.toCompact.length, 2);
});

// --- splitForCompaction with empty history ---

Deno.test('splitForCompaction handles empty history', () => {
  const result = splitForCompaction([], DEFAULT_SPEC);
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 0);
});

// --- splitForCompaction preserves assistant multi-message exchanges ---

Deno.test('splitForCompaction groups tool messages with their exchange', () => {
  const history: TurnHistoryMessage[] = [
    msg('user', 'search for plants'),
    msg('assistant', ''),
    { role: 'tool', tool_call_id: 'call_1', name: 'search', content: 'results...' },
    msg('assistant', 'Here are the results'),
    msg('user', 'thanks'),
    msg('assistant', 'welcome'),
  ];

  const result = splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 1 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 2);
  assertEquals(result.toRetain[0].content, 'thanks');
});

// --- Profile registration validation ---

Deno.test('registerProfile rejects compactAt outside (0,1)', () => {
  registerProfile(defineProfile({
    id: 'compaction.validator.compactor',
    model: { ...modelAllow('gemini35FlashLite'), thinking: 'minimal', maxSteps: 1 },
  }));

  assertThrows(
    () =>
      registerProfile(defineProfile({
        id: 'compaction.validator.bad_compact_at',
        model: {
          allow: ['testModel'],
          config: {
            testModel: {
              ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
              compaction: {
                maxHistoryTokens: 100_000,
                compactAt: 1.5,
                previousExchanges: 5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        },
      })),
    Error,
    'compactAt must be in (0, 1)',
  );
});

Deno.test('registerProfile rejects previousExchanges fraction >= compactAt', () => {
  assertThrows(
    () =>
      registerProfile(defineProfile({
        id: 'compaction.validator.bad_prev_exchanges',
        model: {
          allow: ['testModel'],
          config: {
            testModel: {
              ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
              compaction: {
                maxHistoryTokens: 100_000,
                compactAt: 0.5,
                previousExchanges: 0.5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        },
      })),
    Error,
    'previousExchanges as fraction',
  );
});

Deno.test('registerProfile rejects non-integer previousExchanges >= 1', () => {
  assertThrows(
    () =>
      registerProfile(defineProfile({
        id: 'compaction.validator.bad_prev_exchanges_int',
        model: {
          allow: ['testModel'],
          config: {
            testModel: {
              ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
              compaction: {
                maxHistoryTokens: 100_000,
                compactAt: 0.75,
                previousExchanges: 3.5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        },
      })),
    Error,
    'previousExchanges >= 1 must be an integer',
  );
});

Deno.test('registerProfile rejects unregistered compaction profile', () => {
  assertThrows(
    () =>
      registerProfile(defineProfile({
        id: 'compaction.validator.missing_profile',
        model: {
          allow: ['testModel'],
          config: {
            testModel: {
              ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
              compaction: {
                maxHistoryTokens: 100_000,
                compactAt: 0.75,
                previousExchanges: 5,
                profile: 'nonexistent.compactor',
                timing: 'before',
              },
            },
          },
        },
      })),
    Error,
    "compaction profile 'nonexistent.compactor' must be registered",
  );
});

// --- Runner integration: timing 'before' ---

Deno.test('timing before compacts history before the turn', async () => {
  registerProfile(defineProfile({
    id: 'compaction.runner.compactor',
    model: { ...modelAllow('gemini35FlashLite'), thinking: 'minimal', maxSteps: 1 },
    inputs: { text: true },
    guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
  }));

  const compactorModel: ModelSpec = {
    ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
    compaction: {
      maxHistoryTokens: 1000,
      compactAt: 0.5,
      previousExchanges: 2,
      profile: 'compaction.runner.compactor',
      timing: 'before',
    },
  };

  registerProfile(defineProfile({
    id: 'compaction.runner.speaker',
    model: {
      allow: ['compactModel'],
      config: { compactModel: compactorModel },
      thinking: 'minimal',
    },
    inputs: { text: true },
    guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
  }));

  let compactionTurnFired = false;
  let callCount = 0;
  const mockProvider: ModelProvider = {
    complete: () => {
      callCount++;
      const isCompactionCall = callCount === 1;
      return (async function* () {
        if (isCompactionCall) {
          compactionTurnFired = true;
          yield { type: 'text' as const, text: 'Summary of old conversation' };
          yield { type: 'done' as const };
          return;
        }
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'tokens' as const, tokens: { input: 200, output: 50, total: 250 } };
        yield { type: 'done' as const };
      })();
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'compaction.runner.speaker',
      input: {
        text: 'new question',
        lastInputTokens: 600,
        history: [
          ...exchange('old topic 1', 'old answer 1'),
          ...exchange('old topic 2', 'old answer 2'),
          ...exchange('old topic 3', 'old answer 3'),
          ...exchange('recent 1', 'recent answer 1'),
          ...exchange('recent 2', 'recent answer 2'),
        ],
      },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(compactionTurnFired, true);
  const textEvents = events.filter((e) => e.type === 'text');
  assertEquals(textEvents.length, 1);
  assertEquals(textEvents[0].text, 'response');
});

// --- Runner integration: timing 'after' ---

Deno.test('timing after emits compaction signal in done event', async () => {
  registerProfile(defineProfile({
    id: 'compaction.after.compactor',
    model: { ...modelAllow('gemini35FlashLite'), thinking: 'minimal', maxSteps: 1 },
    inputs: { text: true },
    guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
  }));

  const afterModel: ModelSpec = {
    ...modelAllow('gemini35FlashLite').config.gemini35FlashLite,
    compaction: {
      maxHistoryTokens: 1000,
      compactAt: 0.5,
      previousExchanges: 2,
      profile: 'compaction.after.compactor',
      timing: 'after',
    },
  };

  registerProfile(defineProfile({
    id: 'compaction.after.speaker',
    model: {
      allow: ['afterModel'],
      config: { afterModel },
      thinking: 'minimal',
    },
    inputs: { text: true },
    guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
  }));

  const mockProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'tokens' as const, tokens: { input: 800, output: 50, total: 850 } };
        yield { type: 'done' as const };
      })();
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'compaction.after.speaker',
      input: {
        text: 'question',
        history: [...exchange('a', 'b'), ...exchange('c', 'd')],
      },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  const doneEvent = events.find((e) => e.type === 'done');
  assertEquals(doneEvent?.compaction?.needed, true);
  assertEquals(doneEvent?.compaction?.inputTokens, 800);
});

// Need the ModelSpec type for inline model definitions
import type { ModelSpec } from '../../src/kernel/types.ts';
