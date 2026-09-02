/**
 * Shared tool execution core for model-initiated and host-initiated calls.
 *
 * @module
 */

import type { z } from 'zod';
import { TheorumError, throwIfAborted } from '../../guardrails/error.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import type { Profile, TurnEvent } from '../types.ts';
import { getTool } from './registry.ts';
import { promoteLoadedTools } from './resolve.ts';
import type {
  FunctionToolDef,
  InvokeToolResume,
  LoaderToolDef,
  ModelToolResult,
  ToolCallEvent,
  ToolContext,
  ToolFailure,
  ToolHandler,
  ToolPause,
  ToolPermission,
  ToolStreamEvent,
  TurnToolSnapshot,
} from './types.ts';

function isResumeContinuation(resume?: InvokeToolResume): boolean {
  return resume?.value !== undefined || resume?.granted === true;
}

function isToolPause(value: ToolFailure | ToolPause): value is ToolPause {
  return (
    'kind' in value &&
    (value.kind === 'interactive' || value.kind === 'confirmation' || value.kind === 'permission')
  );
}

async function runHandler<TIn, TOut>(
  tool: FunctionToolDef,
  handler: ToolHandler<TIn, TOut>,
  input: TIn,
  ctx: ToolContext,
): Promise<{ events: ToolStreamEvent<TOut>[]; output?: TOut }> {
  if (tool.handlerStreams) {
    const events: ToolStreamEvent<TOut>[] = [];
    let output: TOut | undefined;
    const gen = (
      handler as (input: TIn, ctx: ToolContext) => AsyncGenerator<ToolStreamEvent<TOut>>
    )(input, ctx);
    for await (const event of gen) {
      events.push(event);
      if (event.kind === 'complete') {
        output = event.output;
      }
    }
    return { events, output };
  }
  const output = await (handler as (input: TIn, ctx: ToolContext) => TOut | Promise<TOut>)(
    input,
    ctx,
  );
  return { events: [{ kind: 'complete', output }], output };
}

function permissionGranted(toolName: string, sessionPermissions?: string[]): boolean {
  if (!sessionPermissions) {
    return false;
  }
  return sessionPermissions.includes('*') || sessionPermissions.includes(toolName);
}

function checkPermission(
  toolName: string,
  permission: ToolPermission,
  sessionPermissions?: string[],
  resume?: InvokeToolResume,
): ToolPause | null {
  if (permission === 'auto') {
    return null;
  }
  if (permission === 'always_confirm') {
    if (resume?.granted === true) {
      return null;
    }
    return {
      kind: 'permission',
      tool: toolName,
      permission,
      input: {},
    };
  }
  if (permissionGranted(toolName, sessionPermissions)) {
    return null;
  }
  return {
    kind: 'permission',
    tool: toolName,
    permission,
    input: {},
  };
}

function toolEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  patch: Partial<ToolCallEvent>,
): TurnEvent {
  return {
    type: 'tool',
    tool: { ...base, ...patch },
  };
}

function failureEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  failure: ToolFailure,
): TurnEvent {
  return toolEvent(base, { phase: 'error', failure });
}

function projectForModel(tool: FunctionToolDef, output: unknown): ModelToolResult {
  if (tool.exposeToModel === false) {
    return { finding: 'Completed.' };
  }
  const finding =
    typeof output === 'object' && output !== null && 'finding' in output
      ? String((output as { finding?: unknown }).finding)
      : JSON.stringify(output);
  return {
    finding: sanitizeText(finding),
    data: output,
  };
}

/** Format model-facing tool output for provider history continuation. */
function formatToolResult(result: ModelToolResult): string {
  if (result.data !== undefined) {
    return sanitizeText(`${result.finding}\n${JSON.stringify(result.data)}`);
  }
  return sanitizeText(result.finding);
}

function* startToolExecution<T>(
  tool: { input: z.ZodType<T> },
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): Generator<TurnEvent, { ok: true; data: T } | { ok: false }> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      message: 'Tool input validation failed',
      details: parsed.error.flatten(),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

async function* executeLoader(
  tool: LoaderToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot,
  profile: Profile,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) return undefined;
  const pause = checkPermission(tool.name, tool.permission, ctx.sessionPermissions, ctx.resume);
  if (pause) {
    pause.input = parsed.data;
    yield toolEvent(base, { phase: 'pause', pause });
    return undefined;
  }
  throwIfAborted(ctx.signal);
  try {
    const resolved = await tool.resolve(parsed.data, ctx);
    const promoted = promoteLoadedTools(snapshot, resolved.loaded, profile);
    const output = { loaded: promoted };
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'Loader output validation failed',
        details: checked.error.flatten(),
      });
      return undefined;
    }
    yield toolEvent(base, { phase: 'complete', output: checked.data });
    return { finding: `Loaded ${String(resolved.loaded.length)} tool(s).`, data: checked.data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield failureEvent(base, { code: 'loader_error', message: msg });
    return undefined;
  }
}

async function* executeFunction(
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) return undefined;
  const input = parsed.data;

  const permissionPause = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionPause) {
    permissionPause.input = input;
    yield toolEvent(base, { phase: 'pause', pause: permissionPause });
    return undefined;
  }

  throwIfAborted(ctx.signal);

  if (tool.canExecute) {
    try {
      const allowed = await tool.canExecute(input, ctx);
      if (!allowed) {
        yield failureEvent(base, {
          code: 'not_authorized',
          message: 'Tool execution not authorized',
        });
        return undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield failureEvent(base, {
        code: 'not_authorized',
        message: `Authorization failed for '${tool.name}': ${msg}`,
      });
      return undefined;
    }
  }

  if (tool.preflight) {
    const pre = await tool.preflight(input, ctx);
    if (pre) {
      if (isToolPause(pre)) {
        const pausePayload: ToolPause = { ...pre, input: pre.input ?? input };
        yield toolEvent(base, { phase: 'pause', pause: pausePayload });
        return undefined;
      }
      yield failureEvent(base, pre);
      return undefined;
    }
  }

  if (tool.interactive && ctx.resume?.value === undefined) {
    const render = tool.interactive.render(input);
    const interactivePause: ToolPause = {
      kind: 'interactive',
      tool: tool.name,
      render,
      input,
    };
    yield toolEvent(base, { phase: 'pause', pause: interactivePause });
    return undefined;
  }

  throwIfAborted(ctx.signal);
  try {
    const { events, output } = await runHandler(tool, tool.handler, input, ctx);
    for (const event of events) {
      throwIfAborted(ctx.signal);
      if (event.kind === 'progress') {
        yield toolEvent(base, { phase: 'progress', data: event.data });
      } else if (event.kind === 'trace') {
        yield toolEvent(base, { phase: 'trace', step: event.step });
      } else if (event.kind === 'artifact') {
        yield toolEvent(base, { phase: 'artifact', artifact: event.artifact });
      } else if (event.kind === 'warning') {
        yield toolEvent(base, { phase: 'warning', warning: event.warning });
      }
    }
    if (output === undefined) {
      yield failureEvent(base, { code: 'invalid_output', message: 'Handler returned no output' });
      return undefined;
    }
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'Tool output validation failed',
        details: checked.error.flatten(),
      });
      return undefined;
    }
    const modelResult = projectForModel(tool, checked.data);
    yield toolEvent(base, { phase: 'complete', output: checked.data });
    return modelResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield failureEvent(base, { code: 'handler_error', message: msg });
    return undefined;
  }
}

async function* executeRegisteredTool(args: {
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile'>;
  snapshot?: TurnToolSnapshot;
}): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const { profile, name, input, callId, ctx, snapshot } = args;
  const tool = getTool(name);
  const base = {
    name,
    callId,
    arguments:
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { value: input },
  };
  if (!tool) {
    yield failureEvent(base, { code: 'unknown_tool', message: `Tool '${name}' is not registered` });
    return undefined;
  }
  if (!profile.tools.allow.includes(name)) {
    yield failureEvent(base, {
      code: 'not_allowed',
      message: `Tool '${name}' is not allowed on ${profile.id}`,
    });
    return undefined;
  }
  if (snapshot && tool.type !== 'builtin') {
    const continuing = isResumeContinuation(ctx.resume);
    if (!continuing && !snapshot.gated.includes(name)) {
      yield failureEvent(base, {
        code: 'not_gated',
        message: `Tool '${name}' is not enabled on this turn`,
      });
      return undefined;
    }
    if (!snapshot.visible.includes(name)) {
      const skipLoadCheck = continuing && tool.loadTier === 'T0';
      if (!skipLoadCheck) {
        yield failureEvent(base, {
          code: 'not_loaded',
          message: `Tool '${name}' is not loaded — use a loader tool first`,
        });
        return undefined;
      }
    }
  }
  const fullCtx: ToolContext = { ...ctx, callId, profile };

  if (tool.type === 'loader') {
    if (!snapshot) {
      throw new TheorumError('Loader tools require a turn tool snapshot');
    }
    return yield* executeLoader(tool, input, fullCtx, snapshot, profile, base);
  }
  if (tool.type === 'function') {
    return yield* executeFunction(tool, input, fullCtx, base);
  }
  yield failureEvent(base, {
    code: 'unknown_tool',
    message: `Tool '${name}' is a builtin and cannot be executed locally`,
  });
  return undefined;
}

function newCallId(name: string): string {
  return `call_${name}_${Date.now()}`;
}

export { executeRegisteredTool, formatToolResult, newCallId, projectForModel };
