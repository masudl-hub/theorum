import { publicError } from '../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../guardrails/sanitize.ts';
import { sinkFromEnv, type TraceSink, writeTrace } from '../../observability/trace.ts';
import { buildRecord } from '../../observability/trace-record.ts';
import { CATALOG } from '../registry/catalog.ts';
import { pickSystemRole, resolveTurn } from '../registry/resolve.ts';
import { executeTool } from '../registry/tools.ts';
import type {
  CustomToolId,
  DynamicToolDeclaration,
  ModelProvider,
  Profile,
  ProfileOutputsSpec,
  ResolvedGeneration,
  ToolEnvelope,
  ToolId,
  TurnEvent,
  TurnHistoryMessage,
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

function executeCustomModelTool(
  profile: Profile,
  name: CustomToolId,
  args: Record<string, unknown>,
): TurnEvent[] {
  try {
    const result = executeTool(profile, name, args);
    const events: TurnEvent[] = [{ type: 'tool', tool: { name, arguments: args, result } }];
    if (result.status === 'error') {
      events.push({ type: 'error', error: publicError(result.finding) });
    }
    return events;
  } catch (err) {
    return [{ type: 'error', error: publicError(err) }];
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
  const args = tool.arguments ?? {};
  return executeCustomModelTool(profile, name as CustomToolId, args);
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

function* interceptProviderTool(
  event: TurnEvent,
  profile: Profile,
  generation: ReturnType<typeof resolveTurn>['generation'],
): Generator<TurnEvent> {
  const tool = event.tool;
  if (!tool) {
    return;
  }
  const isDynamic = generation.dynamicTools?.some((d) => d.name === tool.name);
  if (isDynamic) {
    yield event;
  } else {
    for (const item of dispatchModelTool(profile, event, generation.custom)) {
      yield item;
    }
  }
}

function shouldSkipStreamEvent(event: TurnEvent, profile: Profile): boolean {
  return event.type === 'thought' && profile.outputs.streaming?.streamThoughts === false;
}

function* processNormalEvent(
  event: TurnEvent,
  profile: Profile,
  generation: ReturnType<typeof resolveTurn>['generation'],
): Generator<TurnEvent> {
  if (event.type === 'tool') {
    yield* interceptProviderTool(event, profile, generation);
  } else if (event.type === 'error') {
    yield { type: 'error', error: publicError(event.error) };
  } else {
    yield event;
  }
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
    history: generation.history,
    dynamicTools: generation.dynamicTools,
    structured: generation.structured,
    image: generation.image,
    voice: generation.voice,
    geminiBucket: generation.geminiBucket,
    tapGemini: (row) => {
      gemini.push(row);
    },
  })) {
    if (canary && eventHasCanary(event, canary)) {
      yield redactCanary(event, canary);
      yield { type: 'error', error: publicError('canary leaked') };
      return;
    }
    if (shouldSkipStreamEvent(event, profile)) {
      continue;
    }
    yield* processNormalEvent(event, profile, generation);
  }
}

function isStepLimitReached(step: number, maxSteps: number): boolean {
  if (maxSteps <= 0) {
    return false;
  }
  return step >= maxSteps;
}

function findDynamicDeclaration(
  tools: DynamicToolDeclaration[] | undefined,
  name: string,
): DynamicToolDeclaration | undefined {
  return tools?.find((t) => t.name === name);
}

function formatToolFinding(res: ToolEnvelope): string {
  if (res.finding) {
    return res.finding;
  }
  if (res.data) {
    return JSON.stringify(res.data);
  }
  return 'ok';
}

async function executeDynamicTool(
  decl: DynamicToolDeclaration,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  if (!decl.handler) {
    return { status: 'ok', finding: `${decl.name} accepted (no handler)`, data: args };
  }
  try {
    return await decl.handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', finding: msg };
  }
}

interface StepExecutionState {
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  sawTokensEvent: boolean;
  allEmittedEvents: TurnEvent[];
}

async function* executeAutonomousStep(
  args: {
    profile: Profile;
    generation: ReturnType<typeof resolveTurn>['generation'];
    system: string;
    provider: ModelProvider;
    gemini: Record<string, unknown>[];
  },
  state: StepExecutionState,
  suppressStructured = false,
): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { profile, generation, system, provider, gemini } = args;
  const genForStep = { ...generation, history: state.currentHistory };
  const pendingTools: TurnEvent[] = [];
  let latestStructured: unknown;

  for await (const event of yieldProviderEvents({
    profile,
    generation: genForStep,
    system,
    provider,
    gemini,
  })) {
    if (event.type === 'structured') {
      latestStructured = event.structured;
      if (!suppressStructured) {
        state.allEmittedEvents.push(event);
        yield event;
      }
    } else if (event.type === 'tokens') {
      state.sawTokensEvent = true;
      state.allEmittedEvents.push(event);
      yield event;
    } else if (event.type === 'tool' && event.tool) {
      pendingTools.push(event);
    } else {
      state.allEmittedEvents.push(event);
      yield event;
    }
  }

  return { pendingTools, latestStructured };
}

function appendToolTurnToHistory(
  history: TurnHistoryMessage[],
  toolEv: TurnEvent,
  res: ToolEnvelope,
): void {
  const tool = toolEv.tool;
  if (!tool) {
    return;
  }
  const callId = tool.id ?? `call_${tool.name}_${String(Date.now())}`;
  history.push({
    role: 'assistant',
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(tool.arguments ?? {}),
        },
      },
    ],
  });
  history.push({
    role: 'tool',
    tool_call_id: callId,
    name: tool.name,
    content: formatToolFinding(res),
  });
}

function calculateInputChars(safe: TurnRequest, system: string): number {
  return (
    (safe.input.text?.length ?? 0) +
    (safe.input.fix?.artifact?.length ?? 0) +
    (system?.length ?? 800)
  );
}

function calculateOutputChars(events: TurnEvent[]): { outputChars: number; thinkingChars: number } {
  let outputChars = 0;
  let thinkingChars = 0;
  for (const e of events) {
    if (e.type === 'text' && e.text) outputChars += e.text.length;
    if (e.type === 'structured' && e.structured) outputChars += JSON.stringify(e.structured).length;
    if (e.type === 'thought' && e.text) thinkingChars += e.text.length;
  }
  return { outputChars, thinkingChars };
}

function* calculateFallbackTokens(
  safe: TurnRequest,
  system: string,
  events: TurnEvent[],
): Generator<TurnEvent> {
  const inputChars = calculateInputChars(safe, system);
  const { outputChars, thinkingChars } = calculateOutputChars(events);
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

async function* handlePendingDynamicTools(
  pendingTools: TurnEvent[],
  dynamicTools: DynamicToolDeclaration[] | undefined,
  state: StepExecutionState,
): AsyncGenerator<TurnEvent, boolean> {
  let hasRunnableHandler = false;
  for (const toolEv of pendingTools) {
    const tool = toolEv.tool;
    if (!tool) {
      continue;
    }
    const decl = findDynamicDeclaration(dynamicTools, tool.name);
    if (decl?.handler) {
      hasRunnableHandler = true;
      const res = await executeDynamicTool(decl, tool.arguments ?? {});
      const enrichedEvent: TurnEvent = {
        type: 'tool',
        tool: { ...tool, result: res },
      };
      state.allEmittedEvents.push(enrichedEvent);
      yield enrichedEvent;
      appendToolTurnToHistory(state.currentHistory, toolEv, res);
    } else {
      state.allEmittedEvents.push(toolEv);
      yield toolEv;
    }
  }
  return hasRunnableHandler;
}

async function* executeAttempt(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ReturnType<typeof resolveTurn>['generation'];
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
  state: StepExecutionState;
}): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { profile, generation, system, provider, gemini, state } = args;
  let latestStructured: unknown;
  let pendingTools: TurnEvent[] = [];
  let stepInAttempt = 0;
  const hasValidation = Boolean(profile.outputs.validation);

  while (!isStepLimitReached(stepInAttempt, generation.maxSteps)) {
    stepInAttempt++;
    state.stepCount++;
    const stepResult = yield* executeAutonomousStep(
      { profile, generation, system, provider, gemini },
      state,
      hasValidation,
    );
    if (stepResult.latestStructured !== undefined) {
      latestStructured = stepResult.latestStructured;
    }
    pendingTools = stepResult.pendingTools;

    if (pendingTools.length === 0) {
      break;
    }

    const hasRunnableHandler = yield* handlePendingDynamicTools(
      pendingTools,
      generation.dynamicTools,
      state,
    );
    if (!hasRunnableHandler) {
      break;
    }
  }

  return { pendingTools, latestStructured };
}

function buildFixRequest(
  safe: TurnRequest,
  artifact: unknown,
  error: string,
  repairGuidance?: string,
): TurnRequest {
  return {
    ...safe,
    input: {
      ...safe.input,
      fix: {
        artifact: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
        error,
        guidance: repairGuidance,
      },
    },
  };
}

function hasValidatableArtifact(
  validation: ProfileOutputsSpec['validation'],
  latestStructured: unknown,
): boolean {
  if (!validation || latestStructured === undefined) {
    return false;
  }
  const artifact = validation.extract(latestStructured);
  return artifact !== undefined && artifact !== null;
}

async function evaluateValidationAttempt(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  latestStructured: unknown,
  slots: Record<string, string> | undefined,
): Promise<{ artifact: unknown; isValid: boolean; error: string }> {
  const artifact = validation.extract(latestStructured);
  const check = await validation.validate(artifact, slots);
  const error = check.error || check.finding || 'Validation failed';
  return { artifact, isValid: Boolean(check.isValid), error };
}

async function* runAttemptsWithValidation(
  safe: TurnRequest,
  profile: Profile,
  generation: ReturnType<typeof resolveTurn>['generation'],
  system: string,
  provider: ModelProvider,
  gemini: Record<string, unknown>[],
  state: StepExecutionState,
): AsyncGenerator<TurnEvent> {
  const validation = profile.outputs.validation;
  const maxRetries = validation?.maxRetries ?? 0;
  let currentAttempt = 0;
  let currentGen = generation;
  let currentReq = safe;

  while (currentAttempt <= maxRetries) {
    const { latestStructured } = yield* executeAttempt({
      safe: currentReq,
      profile,
      generation: currentGen,
      system,
      provider,
      gemini,
      state,
    });

    if (!validation || !hasValidatableArtifact(validation, latestStructured)) {
      break;
    }

    const { artifact, isValid, error } = await evaluateValidationAttempt(
      validation,
      latestStructured,
      currentReq.input.slots,
    );

    if (isValid || currentAttempt + 1 > maxRetries) {
      const structEv: TurnEvent = { type: 'structured', structured: latestStructured };
      state.allEmittedEvents.push(structEv);
      yield structEv;
      break;
    }

    currentAttempt++;
    currentReq = buildFixRequest(safe, artifact, error, validation.repairGuidance);
    const resolved = resolveTurn(sanitizeTurnRequest(currentReq));
    currentGen = resolved.generation;
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

  const state: StepExecutionState = {
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    sawTokensEvent: false,
    allEmittedEvents: [],
  };

  yield* runAttemptsWithValidation(safe, profile, generation, system, provider, gemini, state);

  if (!state.sawTokensEvent) {
    yield* calculateFallbackTokens(safe, system, state.allEmittedEvents);
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
