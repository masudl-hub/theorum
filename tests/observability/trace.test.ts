import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
} from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';

function stubRecord(): TraceRecord {
  return {
    v: 1,
    id: 'x',
    ts: 1,
    ms: 1,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: false,
    profile: 'chat',
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function* fakeComplete(): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: 'ok' };
  yield {
    type: 'media',
    media: { mimeType: 'image/jpeg', data: 'secret-bytes' },
  };
}

const fake: ModelProvider = { complete: fakeComplete };

Deno.test('runTurn traces projectId and hashes media not bytes', async () => {
  const into: TraceRecord[] = [];
  await collect(
    runTurn(
      {
        profile: 'image',
        projectId: 'proj-9',
        input: {
          text: 'fox',
          attachments: [{ mimeType: 'image/png', data: 'ex' }],
        },
      },
      fake,
      memorySink(into),
    ),
  );
  assertEquals(into.length, 1);
  const [row] = into;
  if (!row) {
    throw new Error('missing trace');
  }
  assertEquals(row.projectId, 'proj-9');
  assertEquals(row.profile, 'image');
  assertEquals(row.ok, true);
  assertEquals(row.previousInteractionId, null);
  assertEquals(row.store, null);
  assertEquals(row.title, 'fox');
  assertEquals(row.model?.apiId, 'gemini-3.1-flash-lite-image');
  assertEquals(row.input.attachments[0]?.mimeType, 'image/png');
  assertEquals(Boolean(row.input.attachments[0]?.sha256), true);
  const dumped = JSON.stringify(row);
  assertEquals(dumped.includes('secret-bytes'), false);
  const wire = row.wire as Record<string, unknown>;
  assertEquals(Object.hasOwn(wire, 'store'), false);
  assertEquals(typeof wire.system_instruction, 'string');
  assertEquals(Object.hasOwn(wire, 'previous_interaction_id'), false);
  assertEquals(
    row.events.some((event) => event.media?.sha256),
    true,
  );
});

Deno.test('runTurn traces explicit Interactions state controls', async () => {
  const into: TraceRecord[] = [];
  await collect(
    runTurn(
      {
        profile: 'chat',
        previousInteractionId: 'v1_prev',
        store: false,
        input: { text: 'continue' },
      },
      { complete: fakeComplete },
      memorySink(into),
    ),
  );
  const [row] = into;
  if (!row) {
    throw new Error('missing trace');
  }
  assertEquals(row.previousInteractionId, 'v1_prev');
  assertEquals(row.store, false);
  const wire = row.wire as Record<string, unknown>;
  assertEquals(wire.previous_interaction_id, 'v1_prev');
  assertEquals(wire.store, false);
});

Deno.test('runTurn forwards Interactions state controls and preserves host metadata', async () => {
  const into: TraceRecord[] = [];
  const seen: ProviderCompleteRequest[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      seen.push(req);
      yield { type: 'text', text: 'continued' };
    },
  };

  await collect(
    runTurn(
      {
        profile: 'chat',
        previousInteractionId: 'v1_prev_2',
        store: true,
        metadata: {
          channel: 'imessage',
          deliveryPath: 'demo',
          nested: { untouched: true },
        },
        input: { text: 'continue with metadata' },
      },
      provider,
      memorySink(into),
    ),
  );

  assertEquals(seen[0]?.previousInteractionId, 'v1_prev_2');
  assertEquals(seen[0]?.store, true);
  assertEquals(into[0]?.metadata, {
    channel: 'imessage',
    deliveryPath: 'demo',
    nested: { untouched: true },
  });
});

Deno.test('sinkFromDir is a noop when trace dir is empty', async () => {
  const sink = sinkFromDir('');
  await sink.write(stubRecord());
});

Deno.test('noopSink drops traces without filesystem access', async () => {
  await noopSink().write(stubRecord());
});

Deno.test('trace dir never resolves inside the clone', () => {
  assertEquals(
    resolveTraceDir({
      dir: './theorum/traces',
      fallbackDir: '/Users/me/.local/share/theorum/traces',
      cwd: '/Users/me/Development/host-app',
    }),
    '/Users/me/.local/share/theorum/traces',
  );
  assertEquals(
    resolveTraceDir({
      dir: '/app/theorum/traces',
      fallbackDir: '/var/lib/theorum-traces',
      cwd: '/app',
    }),
    '/var/lib/theorum-traces',
  );
});

Deno.test('jsonl sink writes a day file and drops stale turns', async () => {
  const dir = await Deno.makeTempDir();
  const stale = `${dir}/turns-2000-01-01.jsonl`;
  await Deno.writeTextFile(stale, '{}\n');
  const sink = jsonlSink(dir, () => Date.parse('2026-08-16T00:00:00.000Z'));
  await sink.write({ ...stubRecord(), id: 'a', ms: 2 });
  let staleGone = true;
  try {
    await Deno.stat(stale);
    staleGone = false;
  } catch {
    staleGone = true;
  }
  assertEquals(staleGone, true);
  const today = await Deno.readTextFile(`${dir}/turns-2026-08-16.jsonl`);
  assertEquals(today.includes('"profile":"chat"'), true);
});

Deno.test('buildRecord and trace utilities test all edge cases, canaries, sanitization, and titles', async () => {
  const { buildRecord } = await import('../../src/observability/trace-record.ts');
  const { httpStatus, completedInteraction } = await import(
    '../../src/observability/trace-usage.ts'
  );

  // 1. httpStatus and completedInteraction with non-arrays and various rows
  assertEquals(httpStatus(null), undefined);
  assertEquals(completedInteraction(null), undefined);
  assertEquals(httpStatus([{ event_type: 'http_response', status: 200 }]), 200);
  assertEquals(
    completedInteraction([{ event_type: 'interaction.complete', interaction: { id: 'done_1' } }])
      ?.id,
    'done_1',
  );

  // 2. buildRecord with whitespace title, canary in record, string error, tool without result
  const canaryToken = 'theo-canary-secret-123';
  const longText = '   hello world    '.repeat(10);
  const rec = await buildRecord({
    req: {
      profile: 'chat',
      input: {
        text: longText,
        // no attachments or voice
      },
    },
    events: [
      {
        type: 'tool',
        tool: { name: 'unresulted_tool', arguments: { a: 1 } },
      },
      {
        type: 'evidence',
        evidence: { provider: 'openrouter', citations: ['https://theorum.dev'] },
      },
      {
        type: 'error',
        error: `Error containing canary ${canaryToken}`,
      },
    ],
    started: Date.now() - 50,
    thrown: `Direct thrown string containing canary ${canaryToken}`,
    canary: canaryToken,
    gemini: [{ event_type: 'interaction.completed', status: 'cancelled' }],
  });

  assertEquals(rec.cancelled, true);
  assertEquals(rec.ok, false);
  assertEquals(rec.title?.length, 80);
  assertEquals(rec.errorInternal, '[omitted - canary]');
});

Deno.test('writeTrace swallows sink failures safely', async () => {
  const { writeTrace } = await import('../../src/observability/trace.ts');
  const failingSink = {
    write: () => Promise.reject(new Error('Disk full')),
  };
  await writeTrace(failingSink, Promise.resolve(stubRecord()));
});

Deno.test('resolveTraceDir rejects missing and identical directory roots', () => {
  assertEquals(resolveTraceDir({ cwd: '/app' }), undefined);
  assertEquals(
    resolveTraceDir({
      dir: '/app/traces',
      fallbackDir: '/fallback/traces',
      cwd: '/app/traces/',
    }),
    '/fallback/traces',
  );
});
