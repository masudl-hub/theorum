import { throwIfAborted } from '../../../guardrails/error.ts';
import type {
  ModelProvider,
  Profile,
  ResolvedGeneration,
  ToolEnvelope,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { recordStepEvent, type StepExecutionState } from './state.ts';
import { yieldProviderEvents } from './stream.ts';
import {
  executeDynamicDeclaration,
  findDynamicDeclaration,
  formatToolFinding,
  isActionableDynamicDeclaration,
} from './tools.ts';

function isStepLimitReached(step: number, maxSteps: number): boolean {
  if (maxSteps <= 0) {
    return false;
  }
  return step >= maxSteps;
}

async function* executeAutonomousStep(
  args: {
    profile: Profile;
    generation: ResolvedGeneration;
    system: string;
    provider: ModelProvider;
    gemini: Record<string, unknown>[];
    signal?: AbortSignal;
  },
  state: StepExecutionState,
  buffer: { holdLate: boolean; holdUserVisible: boolean } = {
    holdLate: false,
    holdUserVisible: false,
  },
): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { profile, generation, system, provider, gemini, signal } = args;
  const genForStep = { ...generation, history: state.currentHistory };
  const pendingTools: TurnEvent[] = [];
  let latestStructured: unknown;

  for await (const event of yieldProviderEvents({
    profile,
    generation: genForStep,
    system,
    provider,
    gemini,
    signal,
  })) {
    if (event.type === 'structured') {
      latestStructured = event.structured;
    }
    if (event.type === 'done') {
      if (event.stop) {
        state.lastStop = event.stop;
      }
      continue;
    }
    if (event.type === 'tool' && event.tool) {
      pendingTools.push(event);
      continue;
    }
    recordStepEvent(event, state);
    const isUserVisible = event.type === 'thought' || event.type === 'text';
    // Egress must not stream user-visible text before the gate runs.
    // Validation-only may stream thought/text live and only hold structured.
    const streamNow =
      !buffer.holdLate || event.type === 'tokens' || (isUserVisible && !buffer.holdUserVisible);
    if (streamNow) {
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
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  gemini: Record<string, unknown>[];
  state: StepExecutionState;
}): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { profile, generation, system, provider, gemini, state } = args;
  let latestStructured: unknown;
  let pendingTools: TurnEvent[] = [];
  let stepInAttempt = 0;
  const holdUserVisible = Boolean(profile.guardrails.egress?.enforce);
  const holdLate = Boolean(profile.outputs.validation) || holdUserVisible;

  while (!isStepLimitReached(stepInAttempt, generation.maxSteps)) {
    throwIfAborted(args.safe.signal);
    stepInAttempt++;
    state.stepCount++;
    const stepResult = yield* executeAutonomousStep(
      { profile, generation, system, provider, gemini, signal: args.safe.signal },
      state,
      { holdLate, holdUserVisible },
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

export { executeAttempt };
