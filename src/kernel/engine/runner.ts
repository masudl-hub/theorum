import { publicError } from '../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { sinkFromEnv, type TraceSink, writeTrace } from '../../observability/trace.ts';
import { buildRecord } from '../../observability/trace-record.ts';
import { CATALOG } from '../registry/catalog.ts';
import { pickSystemRole, resolveTurn } from '../registry/resolve.ts';
import { executeTool } from '../registry/tools.ts';
import type {
  CustomToolId,
  ModelProvider,
  Profile,
  ResolvedGeneration,
  ToolId,
  TurnEvent,
  TurnRequest,
} from '../types.ts';
import { bindCanary, eventHasCanary, redactCanary } from './boundary.ts';

function* invokeFromUi(profile: Profile, req: TurnRequest): Generator<TurnEvent> {
  const invoke = req.toolInvoke;
  if (!invoke) {
    return;
  }
  try {
    const result = executeTool(profile, invoke.name, invoke.arguments);
    yield {
      type: 'tool',
      tool: { name: invoke.name, arguments: invoke.arguments, result },
    };
    if (result.status === 'error') {
      yield { type: 'error', error: publicError(result.finding) };
      return;
    }
    yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', error: publicError(err) };
    yield { type: 'done' };
  }
}

function dispatchModelTool(profile: Profile, event: TurnEvent, gated: CustomToolId[]): TurnEvent[] {
  const { tool } = event;
  if (!tool) {
    return [];
  }
  const name = tool.name as ToolId;
  if (CATALOG.tools[name]?.kind === 'builtin') {
    return [event];
  }
  if (!gated.includes(name as CustomToolId)) {
    return [{ type: 'error', error: publicError(`Tool '${name}' is not gated on this turn`) }];
  }
  try {
    const { arguments: toolArgs } = tool;
    let args: Record<string, unknown> = {};
    if (toolArgs) {
      args = toolArgs;
    }
    const result = executeTool(profile, name as CustomToolId, args);
    const events: TurnEvent[] = [{ type: 'tool', tool: { name, arguments: args, result } }];
    if (result.status === 'error') {
      events.push({ type: 'error', error: publicError(result.finding) });
    }
    return events;
  } catch (err) {
    return [{ type: 'error', error: publicError(err) }];
  }
}

function systemFromProfile(profile: Profile, role: string): string {
  const { identity } = profile;
  const { systemByRole, system } = identity;
  if (systemByRole) {
    const byRole = systemByRole[role];
    if (byRole) {
      return byRole;
    }
  }
  if (system) {
    return system;
  }
  return '';
}

async function* yieldProviderEvents(args: {
  profile: Profile;
  generation: ReturnType<typeof resolveTurn>['generation'];
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
}): AsyncGenerator<TurnEvent> {
  const { profile, generation, system, provider, gemini } = args;
  const { canary } = generation;
  for await (const event of provider.complete({
    model: generation.model,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system,
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
    tapGemini: (row) => {
      gemini.push(row);
    },
  })) {
    if (eventHasCanary(event, canary)) {
      yield redactCanary(event, canary);
      yield { type: 'error', error: publicError('canary leaked') };
      return;
    }
    if (event.type === 'tool' && event.tool) {
      const dispatched = dispatchModelTool(profile, event, generation.custom);
      for (const item of dispatched) {
        yield item;
      }
    } else if (event.type === 'error') {
      yield { type: 'error', error: publicError(event.error) };
    } else {
      yield event;
    }
  }
}

function* flushRemainingEvents(events: TurnEvent[], out: TurnEvent[]): Generator<TurnEvent> {
  for (const e of events) {
    if (e.type !== 'thought' && e.type !== 'text') {
      out.push(e);
      yield e;
    }
  }
}

async function* emitTurn(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ReturnType<typeof resolveTurn>['generation'];
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
}): AsyncGenerator<TurnEvent> {
  const { safe, profile, generation, system, provider, gemini } = args;
  if (safe.toolInvoke) {
    yield* invokeFromUi(profile, safe);
    return;
  }

  const { validation } = profile;
  const maxRetries = validation?.maxRetries ?? 0;
  let currentAttempt = 0;
  let currentGen = generation;
  let currentReq = safe;
  let sawTokensEvent = false;
  const allEmittedEvents: TurnEvent[] = [];

  while (currentAttempt <= maxRetries) {
    const attemptEvents: TurnEvent[] = [];
    let latestStructured: unknown;
    for await (const event of yieldProviderEvents({
      profile,
      generation: currentGen,
      system,
      provider,
      gemini,
    })) {
      if (event.type === 'structured') {
        latestStructured = event.structured;
      }
      if (event.type === 'tokens') {
        sawTokensEvent = true;
      }
      attemptEvents.push(event);
      if (event.type === 'thought' || event.type === 'text') {
        allEmittedEvents.push(event);
        yield event;
      }
    }

    const shouldBreak =
      !validation ||
      latestStructured === undefined ||
      (() => {
        const artifact = validation.extract(latestStructured);
        return artifact === undefined || artifact === null;
      })();

    if (shouldBreak) {
      yield* flushRemainingEvents(attemptEvents, allEmittedEvents);
      break;
    }

    const artifact = validation.extract(latestStructured);
    const check = await validation.validate(artifact, currentReq.input.slots);
    if (check.isValid || currentAttempt + 1 > maxRetries) {
      yield* flushRemainingEvents(attemptEvents, allEmittedEvents);
      break;
    }

    currentAttempt++;

    // Auto-correction turn: synthesize fix request
    currentReq = {
      ...safe,
      input: {
        ...safe.input,
        fix: {
          artifact: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
          error: check.error || check.finding || 'Validation failed',
          guidance: validation.repairGuidance,
        },
      },
    };
    const resolved = resolveTurn(sanitizeTurnRequest(currentReq));
    currentGen = resolved.generation;
  }

  // If the provider didn't emit usage metadata (e.g. unit test mocks or plain providers),
  // emit a calculated tokens event so token counting is always available across the platform.
  if (!sawTokensEvent) {
    const inputChars =
      (safe.input.text?.length ?? 0) +
      (safe.input.fix?.artifact?.length ?? 0) +
      (system?.length ?? 800);
    let outputChars = 0;
    let thinkingChars = 0;
    for (const e of allEmittedEvents) {
      if (e.type === 'text' && e.text) outputChars += e.text.length;
      if (e.type === 'structured' && e.structured)
        outputChars += JSON.stringify(e.structured).length;
      if (e.type === 'thought' && e.text) thinkingChars += e.text.length;
    }
    const inputTokens = Math.max(1, Math.round(inputChars / 4));
    const outputTokens = Math.max(1, Math.round(outputChars / 4));
    const thinkingTokens = thinkingChars ? Math.round(thinkingChars / 4) : 0;
    yield {
      type: 'tokens',
      tokens: {
        input: inputTokens,
        output: outputTokens,
        thinking: thinkingTokens,
        toolUse: 0,
        total: inputTokens + outputTokens + thinkingTokens,
      },
    };
  }

  yield { type: 'done' };
}

async function* runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sink: TraceSink = sinkFromEnv(),
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
    const { profile, generation: gen } = resolveTurn(safe);
    generation = gen;
    const { model: resolvedModel, geminiBucket, canary: turnCanary } = gen;
    model = resolvedModel;
    bucket = geminiBucket;
    canary = turnCanary;
    const role = pickSystemRole(profile, safe.input.role);
    const bound = bindCanary(systemFromProfile(profile, role), turnCanary);
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
    buildRecord({ req, events: seen, started, model, bucket, gemini, canary, system, generation }),
  );
}

export { runTurn };
