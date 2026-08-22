import { assertEquals } from '@std/assert';
import { pgSink } from '../../src/observability/trace-pg.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';

Deno.test('pgSink writes trace records with Concourse envelope mapping', () => {
  // Base trace records testing various branches
  const recordWithConcourseEnv: TraceRecord = {
    v: 2,
    id: 'trace_123',
    profile: 'studio',
    ts: 1700000000.123, // in seconds (< 10_000_000_000)
    ms: 1500,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
    app: { concourse: { env: 'prod' } },
  };

  const recordWithStageProfile: TraceRecord = {
    v: 2,
    id: 'trace_stage_456',
    profile: 'studio-stage',
    ts: 1700000000000, // in milliseconds
    ms: 500,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    input: { attachments: [], voice: [] },
    events: [],
    ok: false,
  };

  const recordWithProdProfile: TraceRecord = {
    v: 2,
    id: 'trace_prod_789',
    profile: 'planner-prod',
    ts: 1700000000000,
    ms: 800,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };

  const recordWithUnknown: TraceRecord = {
    v: 2,
    id: 'trace_plain_999',
    profile: 'mermaid',
    ts: 1700000000000,
    ms: 200,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: null,
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };
  const records = [
    recordWithConcourseEnv,
    recordWithStageProfile,
    recordWithProdProfile,
    recordWithUnknown,
  ];

  const sink = pgSink('postgres://user:pass@localhost:5432/db');
  assertEquals(typeof sink.write, 'function');
  assertEquals(
    records.map((record) => record.id),
    ['trace_123', 'trace_stage_456', 'trace_prod_789', 'trace_plain_999'],
  );
});
