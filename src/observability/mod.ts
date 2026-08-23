/**
 * Trace sinks and trace record helpers for THEORUM.
 *
 * THEORUM does not own a database or environment variable. Host applications
 * choose a sink and pass it into `runTurn`, or use the noop sink for tests.
 *
 * @module
 */

export type { TraceSink } from './trace.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
  writeTrace,
} from './trace.ts';
export type { TraceRecord } from './trace-record.ts';
