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
    if (event.type === 'done') {
      continue;
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

export { executeAttempt };
