/**
 * Deterministic turn runner for THEORUM.
 *
 * `runTurn` resolves a profile, sanitizes input, binds canary boundaries,
 * streams provider events, executes allowed tools, applies validation and
 * egress repair loops, writes traces, and emits one terminal `done` event.
 *
 * @module
 */

import { throwIfAborted } from '../../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import { noopSink, type TraceSink, writeTrace } from '../../../observability/trace.ts';
import { buildRecord } from '../../../observability/trace-record.ts';
import { pickSystemRole, resolveTurn } from '../../registry/resolve.ts';
import type {
  CompactionSignal,
  CompactionSpec,
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { bindCanary } from '../boundary.ts';
import { compactionNeeded, splitForCompaction } from '../compaction.ts';
import { runAttemptsWithValidation } from './gates.ts';
import type { StepExecutionState } from './state.ts';
import { shouldSkipStreamEvent, systemFromProfile } from './stream.ts';
import { calculateFallbackTokens } from './tokens.ts';
import { invokeFromUi } from './tools.ts';

function getCompactionSpec(profile: Profile, modelId: string): CompactionSpec | undefined {
  return profile.model.config[modelId]?.compaction;
}

async function runCompactionTurn(
  toCompact: TurnHistoryMessage[],
  spec: CompactionSpec,
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<TurnHistoryMessage> {
  const compactText = toCompact
    .map((m) => {
      const content = m.content ?? m.parts?.map((p) => ('text' in p ? p.text : '')).join('') ?? '';
      return `[${m.role}]: ${content}`;
    })
    .join('\n');

  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    {
      profile: spec.profile,
      input: { text: compactText },
      signal,
      metadata: { _compacting: true },
    },
    provider,
  )) {
    events.push(event);
  }

  const structured = events.find((e) => e.type === 'structured')?.structured;
  const text = structured
    ? JSON.stringify(structured)
    : events
        .filter((e) => e.type === 'text')
        .map((e) => e.text ?? '')
        .join('');

  return {
    role: 'assistant',
    content: text,
    metadata: { compactionSummary: true },
  };
}

function lastTokensFromEvents(events: TurnEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].tokens?.input) {
      return events[i].tokens!.input;
    }
  }
  return 0;
}

async function* emitTurn(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
}): AsyncGenerator<TurnEvent> {
  const { safe, profile, generation, system, provider, gemini } = args;
  if (safe.toolInvoke) {
    yield* invokeFromUi(profile, safe);
    return;
  }

  const state: StepExecutionState = {
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    sawTokensEvent: false,
    allEmittedEvents: [],
    attemptEvents: [],
  };

  yield* runAttemptsWithValidation(safe, profile, generation, system, provider, gemini, state);

  if (!state.sawTokensEvent) {
    yield* calculateFallbackTokens(safe, system, state.allEmittedEvents);
  }

  yield { type: 'done' };
}

/** Execute one host turn against a provider adapter. */
async function* runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sink: TraceSink = noopSink(),
): AsyncGenerator<TurnEvent> {
  const started = Date.now();
  const seen: TurnEvent[] = [];
  const gemini: Record<string, unknown>[] = [];
  let model: string | undefined;
  let bucket: string | undefined;
  let canary = '';
  let system: string | undefined;
  let generation: ResolvedGeneration | undefined;
  let safe: TurnRequest | undefined;
  try {
    safe = sanitizeTurnRequest(req);
    throwIfAborted(safe.signal);
    const { profile, generation: gen } = resolveTurn(safe);
    generation = gen;
    const { model: resolvedModel, geminiBucket, canary: turnCanary } = gen;
    model = resolvedModel;
    bucket = geminiBucket;
    canary = turnCanary;

    const isCompacting = req.metadata?._compacting === true;
    const compactionSpec = isCompacting
      ? undefined
      : getCompactionSpec(profile, resolvedModel);

    if (
      compactionSpec?.timing === 'before' &&
      gen.history?.length &&
      safe.input?.lastInputTokens != null &&
      compactionNeeded(safe.input.lastInputTokens, compactionSpec)
    ) {
      const { toCompact, toRetain } = splitForCompaction(gen.history, compactionSpec);
      if (toCompact.length > 0) {
        const compactProvider = req.compactionProvider ?? provider;
        const summaryMessage = await runCompactionTurn(
          toCompact,
          compactionSpec,
          compactProvider,
          safe.signal,
        );
        gen.history = [summaryMessage, ...toRetain];
      }
    }

    const role = pickSystemRole(profile, safe.input?.role);
    const profileSys = systemFromProfile(profile, role);
    const combinedSys = [profileSys, safe.system].filter(Boolean).join('\n\n');
    const bound = bindCanary(combinedSys, turnCanary);
    system = bound;
    for await (const event of emitTurn({
      safe,
      profile,
      generation: gen,
      system: bound,
      provider,
      gemini,
    })) {
      if (event.type === 'done' && compactionSpec?.timing === 'after' && !isCompacting) {
        const inputTokens = lastTokensFromEvents(seen);
        if (inputTokens > 0 && compactionNeeded(inputTokens, compactionSpec)) {
          const currentHistory = gen.history ?? [];
          const signal: CompactionSignal = {
            needed: true,
            inputTokens,
            history: currentHistory,
          };
          const doneWithCompaction: TurnEvent = { ...event, compaction: signal };
          seen.push(doneWithCompaction);
          if (!shouldSkipStreamEvent(doneWithCompaction, profile)) {
            yield doneWithCompaction;
          }
          continue;
        }
      }
      seen.push(event);
      if (shouldSkipStreamEvent(event, profile)) {
        continue;
      }
      yield event;
    }
  } catch (err) {
    await writeTrace(
      sink,
      buildRecord({
        req,
        events: seen,
        started,
        model,
        bucket,
        thrown: err,
        gemini,
        canary,
        system,
        generation,
        sanitizedReq: safe,
      }),
    );
    throw err;
  }
  await writeTrace(
    sink,
    buildRecord({
      req,
      events: seen,
      started,
      model,
      bucket,
      gemini,
      canary,
      system,
      generation,
      sanitizedReq: safe,
    }),
  );
}

export { runTurn };
