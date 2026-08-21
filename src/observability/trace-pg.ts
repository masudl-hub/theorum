/**
 * Postgres-backed TraceSink. Writes TraceRecords as Concourse envelopes
 * directly into concourse_eval.envelope, replacing the JSONL intermediary.
 *
 * Activated when CONCOURSE_PG_URL is set in the environment.
 */
import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts';
import type { TraceSink } from './trace.ts';
import type { TraceRecord } from './trace-record.ts';

const SCHEMA = 'concourse_eval';
const TABLE = `${SCHEMA}.envelope`;

const INSERT_SQL = `
  INSERT INTO ${TABLE} (
    id, v, ts, origin_ts, severity, family, kind, env,
    request_id, collector, data
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  ON CONFLICT (id) DO NOTHING
`;

const VALID_ENVS = new Set(['prod', 'stage', 'local', 'unknown']);

function envFromConcourse(rec: TraceRecord): string | null {
  const concourse = (rec as unknown as Record<string, unknown>).concourse;
  if (concourse && typeof concourse === 'object' && !Array.isArray(concourse)) {
    const env = (concourse as { env?: unknown }).env;
    if (typeof env === 'string' && VALID_ENVS.has(env)) {
      return env;
    }
  }
  return null;
}

function envFromRecord(rec: TraceRecord): string | null {
  const env = envFromConcourse(rec);
  if (env) {
    return env;
  }
  const profile = rec.profile ?? '';
  if (profile.includes('stage')) return 'stage';
  if (profile.includes('prod')) return 'prod';
  return null;
}

let pool: Pool | null = null;

function getPool(url: string): Pool {
  if (!pool) {
    pool = new Pool(url, 3, true);
  }
  return pool;
}

function pgSink(pgUrl: string): TraceSink {
  return {
    write: async (record: TraceRecord) => {
      const p = getPool(pgUrl);
      const client = await p.connect();
      try {
        const originTs =
          record.ts < 10_000_000_000 ? Math.round(record.ts * 1000) : Math.round(record.ts);

        await client.queryArray(INSERT_SQL, [
          `theorum:${record.id}`,
          1,
          Date.now(),
          originTs,
          record.ok ? 'info' : 'error',
          'app',
          'app.theorum_trace',
          envFromRecord(record),
          record.id,
          'theorum.pg_sink',
          JSON.stringify(record),
        ]);
      } finally {
        client.release();
      }
    },
  };
}

export { pgSink };
