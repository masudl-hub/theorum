import type { TraceRecord } from './trace-record.ts';

const RETAIN_DAYS = 14;
const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const RETAIN_MS = RETAIN_DAYS * HOURS_PER_DAY * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
const KIB = 1024;
const MIB = KIB * KIB;
const ROTATE_MIB = 32;
const ROTATE_BYTES = ROTATE_MIB * MIB;
const FILE_DAY = /^turns-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/;

interface TraceSink {
  write: (record: TraceRecord) => Promise<void>;
}

async function writeTrace(sink: TraceSink, record: Promise<TraceRecord>): Promise<void> {
  try {
    await sink.write(await record);
  } catch {
    // Tracing must not fail the turn.
  }
}

function noopSink(): TraceSink {
  return { write: () => Promise.resolve() };
}

function memorySink(into: TraceRecord[]): TraceSink {
  return {
    write: (record) => {
      into.push(record);
      return Promise.resolve();
    },
  };
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fileDay(name: string): string | undefined {
  return FILE_DAY.exec(name)?.[1];
}

async function pruneTraces(dir: string, now: number): Promise<void> {
  const cutoff = now - RETAIN_MS;
  for await (const entry of Deno.readDir(dir)) {
    const day = fileDay(entry.name);
    if (day && Date.parse(`${day}T00:00:00.000Z`) < cutoff) {
      await Deno.remove(`${dir}/${entry.name}`);
    }
  }
}

async function pickFile(dir: string, now: number): Promise<string> {
  const day = dayStamp(now);
  const base = `${dir}/turns-${day}.jsonl`;
  try {
    const info = await Deno.stat(base);
    if ((info.size ?? 0) < ROTATE_BYTES) {
      return base;
    }
  } catch {
    return base;
  }
  return `${dir}/turns-${day}-${now}.jsonl`;
}

function jsonlSink(dir: string, now: () => number = Date.now): TraceSink {
  return {
    write: async (record) => {
      const at = now();
      await Deno.mkdir(dir, { recursive: true });
      await pruneTraces(dir, at);
      const path = await pickFile(dir, at);
      await Deno.writeTextFile(path, `${JSON.stringify(record)}\n`, { append: true });
    },
  };
}

function defaultTraceDir(env: { get: (key: string) => string | undefined }): string {
  const home = env.get('HOME')?.trim();
  if (home) {
    return `${home}/.local/share/model-sculpt-studio/theorum-traces`;
  }
  return '/var/lib/theorum-traces';
}

function insideDir(path: string, root: string): boolean {
  let base = root;
  if (root.endsWith('/')) {
    base = root.slice(0, -1);
  }
  if (path === base) {
    return true;
  }
  return path.startsWith(`${base}/`);
}

function resolveTraceDir(args: {
  env: { get: (key: string) => string | undefined };
  cwd?: string;
}): string | undefined {
  const { env } = args;
  const cwd = args.cwd ?? Deno.cwd();
  const raw = env.get('THEORUM_TRACE_DIR');
  if (raw === '') {
    return undefined;
  }
  let dir = raw?.trim() || defaultTraceDir(env);
  if (!dir.startsWith('/') || insideDir(dir, cwd)) {
    dir = defaultTraceDir(env);
  }
  if (insideDir(dir, cwd)) {
    return '/var/lib/theorum-traces';
  }
  return dir;
}

function sinkFromEnv(env: { get: (key: string) => string | undefined } = Deno.env): TraceSink {
  const pgUrl = env.get('CONCOURSE_PG_URL');
  if (pgUrl) {
    let sink: TraceSink | null = null;
    return {
      write: async (record) => {
        if (!sink) {
          const { pgSink } = await import('./trace-pg.ts');
          sink = pgSink(pgUrl);
        }
        await sink.write(record);
      },
    };
  }
  const dir = resolveTraceDir({ env });
  if (!dir) {
    return noopSink();
  }
  return jsonlSink(dir);
}

export type { TraceSink };
export { defaultTraceDir, jsonlSink, memorySink, resolveTraceDir, sinkFromEnv, writeTrace };
