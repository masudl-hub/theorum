import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import {
  defaultTraceDir,
  jsonlSink,
  memorySink,
  resolveTraceDir,
  sinkFromEnv,
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

Deno.test('sinkFromEnv is a noop when THEORUM_TRACE_DIR is empty', async () => {
  const sink = sinkFromEnv({ get: () => '' });
  await sink.write(stubRecord());
});

Deno.test('unset THEORUM_TRACE_DIR defaults next to the share store', () => {
  const dir = defaultTraceDir({
    get: (key) => {
      if (key === 'HOME') {
        return '/Users/me';
      }
    },
  });
  assertEquals(dir, '/Users/me/.local/share/model-sculpt-studio/theorum-traces');
});

Deno.test('trace dir never resolves inside the clone', () => {
  const env = {
    get: (key: string) => {
      if (key === 'THEORUM_TRACE_DIR') {
        return './theorum/traces';
      }
      if (key === 'HOME') {
        return '/Users/me';
      }
    },
  };
  assertEquals(
    resolveTraceDir({ env, cwd: '/Users/me/Development/ml_deno' }),
    '/Users/me/.local/share/model-sculpt-studio/theorum-traces',
  );
  const inRepo = {
    get: (key: string) => {
      if (key === 'THEORUM_TRACE_DIR') {
        return '/app/theorum/traces';
      }
    },
  };
  assertEquals(resolveTraceDir({ env: inRepo, cwd: '/app' }), '/var/lib/theorum-traces');
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

Deno.test('writeTrace swallows sink failures safely', async () => {
  const { writeTrace } = await import('../../src/observability/trace.ts');
  const failingSink = {
    write: () => Promise.reject(new Error('Disk full')),
  };
  await writeTrace(failingSink, Promise.resolve(stubRecord()));
});

Deno.test('defaultTraceDir falls back when HOME is unset and resolveTraceDir handles identical directory roots', () => {
  assertEquals(defaultTraceDir({ get: () => undefined }), '/var/lib/theorum-traces');
  assertEquals(
    resolveTraceDir({
      env: { get: () => '/app/traces' },
      cwd: '/app/traces/',
    }),
    '/var/lib/theorum-traces',
  );
});
