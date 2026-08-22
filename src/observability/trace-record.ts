import { publicError } from '../guardrails/error.ts';
import { sanitizeText, sanitizeTurnRequest } from '../guardrails/sanitize.ts';
import { OMIT_CANARY } from '../kernel/engine/boundary.ts';
import { sha256 } from '../kernel/engine/hash.ts';
import type { ResolvedGeneration, TurnBlob, TurnEvent, TurnRequest } from '../kernel/types.ts';
import { attachResolved, attachTape, attachUsage } from './trace-attach.ts';
import { completedInteraction } from './trace-usage.ts';

const TRACE_VERSION = 2;
const TITLE_MAX = 80;

export interface TraceImage {
  mimeType: string;
  sha256: string;
}

export interface TraceEvent {
  type: string;
  text?: string;
  tool?: {
    name: string;
    arguments?: Record<string, unknown>;
    result?: { status: string; finding: string };
  };
  structured?: unknown;
  media?: TraceImage;
  grounding?: TurnEvent['grounding'];
  evidence?: TurnEvent['evidence'];
  error?: string;
}

interface TraceRecord {
  v: number;
  id: string;
  ts: number;
  ms: number;
  streamed: boolean;
  cancelled: boolean;
  previousInteractionId: string | null;
  store: boolean | null;
  profile: string;
  title?: string;
  projectId?: string;
  select?: string;
  thinking?: boolean;
  tools?: TurnRequest['tools'];
  metadata?: Record<string, unknown>;
  model?: { id: string; apiId: string };
  bucket?: string;
  generation?: {
    thinking: string;
    summaries: string;
    temperature: number;
    maxOutputTokens: number;
    builtins: string[];
    custom: string[];
    structured: string | null;
    image: unknown;
  };
  input: {
    text?: string;
    role?: string;
    slots?: Record<string, string>;
    attachments: TraceImage[];
    voice: TraceImage[];
    images?: TraceImage[];
    audio?: TraceImage[];
  };
  wire?: unknown;
  events: TraceEvent[];
  gemini?: unknown;
  usage?: unknown;
  upstream?: {
    status?: unknown;
    id?: unknown;
    finish?: unknown;
    serviceTier?: unknown;
  };
  ok: boolean;
  error?: string;
  errorInternal?: string;
  app?: Record<string, unknown>;
  cutout?: {
    ok: boolean;
    ms: number;
    url?: string;
    inSha256?: string;
    outSha256?: string;
    http?: unknown;
    error?: string;
  };
}

function hashBlobs(blobs: TurnBlob[] | undefined): Promise<TraceImage[]> {
  if (!blobs) {
    return Promise.resolve([]);
  }
  return Promise.all(
    blobs.map(async (blob) => ({
      mimeType: blob.mimeType,
      sha256: await sha256(blob.data),
    })),
  );
}

async function snapshotEvent(event: TurnEvent): Promise<TraceEvent> {
  const row: TraceEvent = { type: event.type };
  if (event.text) {
    row.text = sanitizeText(event.text);
  }
  if (event.error) {
    row.error = event.error;
  }
  if (event.structured !== undefined) {
    row.structured = event.structured;
  }
  if (event.tool) {
    const { name, arguments: args, result } = event.tool;
    row.tool = { name, arguments: args };
    if (result) {
      row.tool.result = { status: result.status, finding: result.finding };
    }
  }
  if (event.media) {
    row.media = {
      mimeType: event.media.mimeType,
      sha256: await sha256(event.media.data),
    };
  }
  if (event.grounding) {
    row.grounding = event.grounding;
  }
  if (event.evidence) {
    row.evidence = event.evidence;
  }
  return row;
}

function requestForTrace(req: TurnRequest): TurnRequest {
  try {
    return sanitizeTurnRequest(req);
  } catch {
    return { profile: req.profile, input: {} };
  }
}

function internalError(err: unknown): string | undefined {
  if (typeof err === 'string') {
    return sanitizeText(err);
  }
  if (err instanceof Error && err.message) {
    return sanitizeText(err.message);
  }
  return undefined;
}

function titleFrom(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim().replaceAll(/\s+/g, ' ');
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, TITLE_MAX);
}

function attachFailure(
  record: TraceRecord,
  thrown: unknown,
  lastErr: TraceEvent | undefined,
  canary: string | undefined,
): void {
  if (!record.ok) {
    record.error = publicError(thrown ?? lastErr?.error);
    const inside = internalError(thrown) ?? lastErr?.error;
    if (inside) {
      record.errorInternal = inside;
    }
  }
  if (canary && JSON.stringify(record).includes(canary)) {
    record.errorInternal = OMIT_CANARY;
  }
}

async function buildRecord(args: {
  req: TurnRequest;
  events: TurnEvent[];
  started: number;
  model?: string;
  bucket?: string;
  thrown?: unknown;
  gemini?: unknown;
  canary?: string;
  system?: string;
  generation?: ResolvedGeneration;
}): Promise<TraceRecord> {
  const { req, events, started, model, bucket, thrown, gemini, canary, system, generation } = args;
  const safe = requestForTrace(req);
  const snapped = await Promise.all(events.map((event) => snapshotEvent(event)));
  const lastErr = [...snapped].reverse().find((row) => row.type === 'error');
  const done = completedInteraction(gemini);
  const status = done?.status;
  const ok = !(thrown || lastErr) && status !== 'cancelled';
  const record: TraceRecord = {
    v: TRACE_VERSION,
    id: crypto.randomUUID(),
    ts: started,
    ms: Date.now() - started,
    streamed: true,
    cancelled: status === 'cancelled',
    previousInteractionId: safe.previousInteractionId ?? null,
    store: safe.store ?? null,
    profile: safe.profile,
    input: {
      text: safe.input.text,
      role: safe.input.role,
      slots: safe.input.slots,
      attachments: await hashBlobs(safe.input.attachments),
      voice: await hashBlobs(safe.input.voice),
    },
    events: snapped,
    ok,
  };
  const title = titleFrom(safe.input.text);
  if (title) {
    record.title = title;
  }
  await attachTape(record, { gemini, canary, system, generation });
  attachUsage(record, gemini, done);
  attachResolved(record, { safe, model, bucket, generation });
  attachFailure(record, thrown, lastErr, canary);
  return record;
}

export type { TraceRecord };
export { buildRecord };
