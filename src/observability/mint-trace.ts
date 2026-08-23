import { publicError, UPSTREAM_FAILED } from '../guardrails/error.ts';
import { noopSink, type TraceSink, writeTrace } from './trace.ts';
import type { TraceRecord } from './trace-record.ts';

interface CutoutTape {
  ok: boolean;
  ms: number;
  url?: string;
  inSha256?: string;
  outSha256?: string;
  http?: unknown;
  error?: string;
}

function attachMint(row: TraceRecord, app: Record<string, unknown>, cutout: CutoutTape): void {
  row.app = app;
  row.cutout = cutout;
  row.ms = Date.now() - row.ts;
  if (!cutout.ok) {
    row.ok = false;
    const { error: cutoutError } = cutout;
    let error = cutoutError;
    if (!error) {
      error = publicError(UPSTREAM_FAILED);
    }
    row.error = error;
  }
}

async function flushMintTrace(args: {
  held: TraceRecord[];
  app: Record<string, unknown>;
  cutout: CutoutTape;
  sink?: TraceSink;
}): Promise<void> {
  const [row] = args.held;
  if (!row) {
    return;
  }
  attachMint(row, args.app, args.cutout);
  await writeTrace(args.sink ?? noopSink(), Promise.resolve(row));
}

export type { CutoutTape };
export { flushMintTrace };
