import type { ProviderCompleteRequest, ResolvedGeneration, TurnRequest } from '../kernel/types.ts';
import { tapeGemini } from '../providers/gemini-tape.ts';
import { toInteractionsBody } from '../providers/interactions.ts';
import type { TraceRecord } from './trace-record.ts';
import { httpStatus } from './trace-usage.ts';

function completeRequest(generation: ResolvedGeneration, system: string): ProviderCompleteRequest {
  return {
    model: generation.model,
    apiId: generation.apiId,
    openRouterId: generation.openRouterId,
    previousInteractionId: generation.previousInteractionId,
    store: generation.store,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system,
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    geminiBucket: generation.geminiBucket,
  };
}

function attachResolved(
  record: TraceRecord,
  args: {
    safe: TurnRequest;
    model?: string;
    bucket?: string;
    generation?: ResolvedGeneration;
  },
): void {
  const { safe, model, bucket, generation } = args;
  if (safe.projectId) {
    record.projectId = safe.projectId;
  }
  if (safe.select) {
    record.select = safe.select;
  }
  if (safe.thinking !== undefined) {
    record.thinking = safe.thinking;
  }
  if (safe.tools) {
    record.tools = safe.tools;
  }
  if (safe.metadata) {
    record.metadata = safe.metadata;
  }
  if (model) {
    record.model = {
      id: model,
      apiId: generation?.apiId ?? model,
    };
  }
  if (bucket) {
    record.bucket = bucket;
  }
  if (generation) {
    record.generation = {
      thinking: generation.thinking,
      summaries: generation.summaries,
      temperature: generation.temperature,
      maxOutputTokens: generation.maxOutputTokens,
      builtins: generation.builtins,
      custom: generation.custom,
      structured: generation.structured,
      image: generation.image,
    };
  }
}

async function attachTape(
  record: TraceRecord,
  args: {
    gemini?: unknown;
    canary?: string;
    system?: string;
    generation?: ResolvedGeneration;
  },
): Promise<void> {
  const { gemini, canary, system, generation } = args;
  if (gemini !== undefined) {
    record.gemini = await tapeGemini(gemini, canary ?? '');
  }
  if (generation && system !== undefined) {
    record.wire = await tapeGemini(
      toInteractionsBody(completeRequest(generation, system)),
      canary ?? '',
    );
  }
}

function attachUsage(
  record: TraceRecord,
  gemini: unknown,
  done: Record<string, unknown> | undefined,
): void {
  if (done?.usage !== undefined) {
    record.usage = done.usage;
  }
  const upStatus = httpStatus(gemini);
  if (upStatus !== undefined || done) {
    record.upstream = {
      status: upStatus,
      id: done?.id,
      finish: done?.status,
      serviceTier: done?.service_tier ?? done?.serviceTier,
    };
  }
}

export { attachResolved, attachTape, attachUsage };
