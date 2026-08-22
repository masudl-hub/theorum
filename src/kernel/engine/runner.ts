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
    previousInteractionId: generation.previousInteractionId,
    store: generation.store,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system,
    input: generation.input,
    history: generation.history,
    dynamicTools: generation.dynamicTools,
    dynamicToolLoader: generation.dynamicToolLoader,
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

function collectAttemptText(events: TurnEvent[]): string {
  return events
    .filter((e) => e.type === 'text' && e.text)
    .map((e) => e.text)
    .join('');
}

async function checkDynamicAuthorization(
  decl: DynamicToolDeclaration,
  args: Record<string, unknown>,
  profile: Profile,
  sessionPermissions?: string[],
): Promise<ToolEnvelope | null> {
  if (!decl.canExecute) {
    return null;
  }
  try {
    const decision = await decl.canExecute({ args, profile, sessionPermissions });
    if (typeof decision === 'boolean' && !decision) {
      return {
        status: 'error',
        finding: `Tool '${decl.name}' execution not authorized.`,
      };
    }
    if (typeof decision === 'object' && decision !== null) {
      return decision;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', finding: `Authorization error for '${decl.name}': ${msg}` };
  }
}

function checkDynamicPermissionTier(
  decl: DynamicToolDeclaration,
  args: Record<string, unknown>,
  sessionPermissions?: string[],
): ToolEnvelope | null {
  if (decl.permissionTier === 'session_consent' || decl.permissionTier === 'always_confirm') {
    const isGranted = sessionPermissions?.includes(decl.name) || sessionPermissions?.includes('*');
    if (!isGranted) {
      return {
        status: 'pause',
        finding: `Tool '${decl.name}' requires ${decl.permissionTier} authorization.`,
        data: { tool: decl.name, permissionTier: decl.permissionTier, args },
      };
    }
  }
  return null;
}

async function runDynamicHandler(
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

async function executeDynamicTool(
  decl: DynamicToolDeclaration,
  args: Record<string, unknown>,
  profile: Profile,
  sessionPermissions?: string[],
): Promise<ToolEnvelope> {
  const authEnvelope = await checkDynamicAuthorization(decl, args, profile, sessionPermissions);
  if (authEnvelope) {
    return authEnvelope;
  }

  const permissionEnvelope = checkDynamicPermissionTier(decl, args, sessionPermissions);
  if (permissionEnvelope) {
    return permissionEnvelope;
  }

  return runDynamicHandler(decl, args);
}

function mergeDynamicTools(
  current: DynamicToolDeclaration[] | undefined,
  loaded: DynamicToolDeclaration[],
): DynamicToolDeclaration[] {
  const merged = [...(current ?? [])];
  for (const tool of loaded) {
    const existing = merged.findIndex((item) => item.name === tool.name);
    if (existing >= 0) {
      merged[existing] = tool;
    } else {
      merged.push(tool);
    }
  }
  return merged;
}

async function executeDynamicToolLoader(args: {
  decl: DynamicToolDeclaration;
  toolArgs: Record<string, unknown>;
  profile: Profile;
  generation: ResolvedGeneration;
}): Promise<ToolEnvelope> {
  const { decl, toolArgs, profile, generation } = args;
  const loader = generation.dynamicToolLoader;
  if (!loader) {
    return {
      status: 'error',
      finding: `Tool '${decl.name}' is marked as a loader but no loader is configured.`,
    };
  }
  const loaded = await loader({
    name: decl.name,
    args: toolArgs,
    profile,
    currentTools: generation.dynamicTools ?? [],
    sessionPermissions: generation.sessionPermissions,
  });
  generation.dynamicTools = mergeDynamicTools(generation.dynamicTools, loaded);
  return {
    status: 'ok',
    finding: `Loaded ${String(loaded.length)} dynamic tool schema(s).`,
    data: { loadedTools: loaded.map((tool) => tool.name) },
  };
}

function isActionableDynamicDeclaration(
  decl: DynamicToolDeclaration | undefined,
): decl is DynamicToolDeclaration {
  return Boolean(
    decl?.handler || decl?.canExecute || decl?.permissionTier || decl?.loadsDynamicTools,
  );
}

async function executeDynamicDeclaration(args: {
  decl: DynamicToolDeclaration;
  toolArgs: Record<string, unknown>;
  profile: Profile;
  generation: ResolvedGeneration;
}): Promise<ToolEnvelope> {
  const { decl, toolArgs, profile, generation } = args;
  const res = await executeDynamicTool(decl, toolArgs, profile, generation.sessionPermissions);
  if (res.status === 'ok' && decl.loadsDynamicTools) {
    return await executeDynamicToolLoader({ decl, toolArgs, profile, generation });
  }
  return res;
}

interface StepExecutionState {
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  sawTokensEvent: boolean;
  allEmittedEvents: TurnEvent[];
  attemptEvents: TurnEvent[];
}

function recordStepEvent(event: TurnEvent, state: StepExecutionState): void {
  if (event.type === 'tokens') {
    state.sawTokensEvent = true;
  }
  state.allEmittedEvents.push(event);
  state.attemptEvents.push(event);
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
  bufferOutputs = false,
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
    }
    if (event.type === 'tool' && event.tool) {
      pendingTools.push(event);
      continue;
    }
    recordStepEvent(event, state);
    if (!bufferOutputs || event.type === 'tokens') {
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
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
): AsyncGenerator<TurnEvent, boolean> {
  let hasRunnableHandler = false;
  for (const toolEv of pendingTools) {
    const tool = toolEv.tool;
    if (!tool) {
      continue;
    }
    const decl = findDynamicDeclaration(generation.dynamicTools, tool.name);
    if (!isActionableDynamicDeclaration(decl)) {
      state.allEmittedEvents.push(toolEv);
      yield toolEv;
      continue;
    }

    hasRunnableHandler = true;
    const finalResult = await executeDynamicDeclaration({
      decl,
      toolArgs: tool.arguments ?? {},
      profile,
      generation,
    });
    const enrichedEvent: TurnEvent = {
      type: 'tool',
      tool: { ...tool, result: finalResult },
    };
    state.allEmittedEvents.push(enrichedEvent);
    yield enrichedEvent;
    appendToolTurnToHistory(state.currentHistory, toolEv, finalResult);
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
  const shouldBuffer =
    Boolean(profile.outputs.validation) || Boolean(profile.guardrails.egress?.enforce);

  while (!isStepLimitReached(stepInAttempt, generation.maxSteps)) {
    stepInAttempt++;
    state.stepCount++;
    const stepResult = yield* executeAutonomousStep(
      { profile, generation, system, provider, gemini },
      state,
      shouldBuffer,
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
      generation,
      profile,
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

type EgressOutcome =
  | { action: 'pass' }
  | { action: 'refusal'; event: TurnEvent }
  | { action: 'retry'; nextRequest: TurnRequest }
  | { action: 'withhold'; event: TurnEvent };

async function evaluateEgressOutcome(args: {
  egress: NonNullable<Profile['guardrails']['egress']>;
  attemptEvents: TurnEvent[];
  generation: ResolvedGeneration;
  request: TurnRequest;
  profile: Profile;
  canRetry: boolean;
}): Promise<EgressOutcome> {
  const { egress, attemptEvents, generation, request, profile, canRetry } = args;
  const attemptText = collectAttemptText(attemptEvents);
  const result = await egress.enforce({
    text: attemptText,
    canary: generation.canary,
    slots: request.input.slots,
    profile,
    role: request.input.role,
  });

  if (!result.blocked) {
    return { action: 'pass' };
  }

  if (egress.onBlock === 'refuse_to_user') {
    return { action: 'refusal', event: { type: 'text', text: result.text } };
  }

  if (canRetry) {
    const rejectionMsg = result.rejectionMessage || 'Egress disclosure violation detected.';
    const repairGuidance =
      egress.repairGuidance ||
      'Rewrite the message as corrected user-visible prose only. Keep the same helpful substance; scrub all internal tool names, leak phrases, and disclosure markers.';
    const nextRequest = buildFixRequest(request, attemptText, rejectionMsg, repairGuidance);
    return { action: 'retry', nextRequest };
  }

  return {
    action: 'withhold',
    event: { type: 'error', error: publicError('Turn withheld: egress disclosure violation') },
  };
}

type ValidationOutcome =
  | { action: 'pass' }
  | { action: 'retry'; nextRequest: TurnRequest }
  | { action: 'accept'; event: TurnEvent };

async function evaluateValidationOutcome(args: {
  validation: NonNullable<ProfileOutputsSpec['validation']>;
  latestStructured: unknown;
  request: TurnRequest;
  canRetry: boolean;
}): Promise<ValidationOutcome> {
  const { validation, latestStructured, request, canRetry } = args;
  if (!hasValidatableArtifact(validation, latestStructured)) {
    return { action: 'pass' };
  }

  const { artifact, isValid, error } = await evaluateValidationAttempt(
    validation,
    latestStructured,
    request.input.slots,
  );

  if (isValid) {
    return { action: 'pass' };
  }

  if (canRetry) {
    const nextRequest = buildFixRequest(request, artifact, error, validation.repairGuidance);
    return { action: 'retry', nextRequest };
  }

  return { action: 'accept', event: { type: 'structured', structured: latestStructured } };
}

function* yieldBufferedAttemptEvents(events: TurnEvent[]): Generator<TurnEvent> {
  for (const ev of events) {
    if (ev.type !== 'tokens') {
      yield ev;
    }
  }
}

interface AttemptFlowState {
  currentAttempt: number;
  currentReq: TurnRequest;
  currentGen: ResolvedGeneration;
}

function updateFlowForRetry(flow: AttemptFlowState, nextReq: TurnRequest): void {
  flow.currentAttempt++;
  flow.currentReq = nextReq;
  flow.currentGen = resolveTurn(sanitizeTurnRequest(nextReq)).generation;
}

async function* handleEgressGate(
  egress: NonNullable<Profile['guardrails']['egress']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  maxRetries: number,
): AsyncGenerator<TurnEvent, 'continue' | 'terminal' | 'pass'> {
  const canRetry = flow.currentAttempt < maxRetries;
  const outcome = await evaluateEgressOutcome({
    egress,
    attemptEvents: state.attemptEvents,
    generation: flow.currentGen,
    request: flow.currentReq,
    profile,
    canRetry,
  });

  if (outcome.action === 'refusal') {
    state.allEmittedEvents.push(outcome.event);
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'withhold') {
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'retry') {
    updateFlowForRetry(flow, outcome.nextRequest);
    return 'continue';
  }
  return 'pass';
}

async function* handleValidationGate(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  latestStructured: unknown,
  maxRetries: number,
): AsyncGenerator<TurnEvent, 'continue' | 'terminal' | 'pass'> {
  const canRetry = flow.currentAttempt < maxRetries;
  const outcome = await evaluateValidationOutcome({
    validation,
    latestStructured,
    request: flow.currentReq,
    canRetry,
  });

  if (outcome.action === 'retry') {
    updateFlowForRetry(flow, outcome.nextRequest);
    return 'continue';
  }
  if (outcome.action === 'accept') {
    state.allEmittedEvents.push(outcome.event);
    yield outcome.event;
    return 'terminal';
  }
  return 'pass';
}

type AttemptStepAction = { status: 'terminal' } | { status: 'continue' } | { status: 'success' };

function gateStatusToAction(
  status: 'continue' | 'terminal' | 'pass',
  terminalStatus: 'terminal' | 'success' = 'terminal',
): AttemptStepAction | null {
  if (status === 'terminal') {
    return { status: terminalStatus };
  }
  if (status === 'continue') {
    return { status: 'continue' };
  }
  return null;
}

async function* executeSingleAttemptCycle(args: {
  flow: AttemptFlowState;
  state: StepExecutionState;
  profile: Profile;
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
  maxRetries: number;
}): AsyncGenerator<TurnEvent, AttemptStepAction> {
  const { flow, state, profile, system, provider, gemini, maxRetries } = args;
  const validation = profile.outputs.validation;
  const egress = profile.guardrails.egress;

  state.attemptEvents = [];
  const { latestStructured } = yield* executeAttempt({
    safe: flow.currentReq,
    profile,
    generation: flow.currentGen,
    system,
    provider,
    gemini,
    state,
  });

  if (egress?.enforce) {
    const status = yield* handleEgressGate(egress, flow, state, profile, maxRetries);
    const action = gateStatusToAction(status, 'terminal');
    if (action) {
      return action;
    }
  }

  if (validation) {
    const status = yield* handleValidationGate(
      validation,
      flow,
      state,
      latestStructured,
      maxRetries,
    );
    const action = gateStatusToAction(status, 'success');
    if (action) {
      return action;
    }
  }

  if (validation || egress?.enforce) {
    yield* yieldBufferedAttemptEvents(state.attemptEvents);
  }

  return { status: 'success' };
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
  const maxRetries = Math.max(
    profile.outputs.validation?.maxRetries ?? 0,
    profile.guardrails.egress?.maxRetries ?? 2,
  );
  const flow: AttemptFlowState = {
    currentAttempt: 0,
    currentGen: generation,
    currentReq: safe,
  };

  while (flow.currentAttempt <= maxRetries) {
    const step = yield* executeSingleAttemptCycle({
      flow,
      state,
      profile,
      system,
      provider,
      gemini,
      maxRetries,
    });
    if (step.status === 'terminal' || step.status === 'success') {
      break;
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
    buildRecord({ req, events: seen, started, model, bucket, gemini, canary, system, generation }),
  );
}

export { runTurn };
