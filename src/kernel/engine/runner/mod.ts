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
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnRequest,
} from '../../types.ts';
import { bindCanary } from '../boundary.ts';
import { runAttemptsWithValidation } from './gates.ts';
import type { StepExecutionState } from './state.ts';
import { shouldSkipStreamEvent, systemFromProfile } from './stream.ts';
import { calculateFallbackTokens } from './tokens.ts';
import { invokeFromUi } from './tools.ts';

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
  try {
    const safe = sanitizeTurnRequest(req);
    throwIfAborted(safe.signal);
    const { profile, generation: gen } = resolveTurn(safe);
    generation = gen;
    const { model: resolvedModel, geminiBucket, canary: turnCanary } = gen;
    model = resolvedModel;
    bucket = geminiBucket;
    canary = turnCanary;
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
    }),
  );
}

export { runTurn };
