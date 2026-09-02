/**
 * Tool registry types — single catalog, shared execution.
 *
 * @module
 */

import type { z } from 'zod';
import { type ToolLoadTier, TOOL_LOAD_TIERS } from '../schema.ts';
import type { Profile, ToolId, TurnInput } from '../types.ts';

export const TOOL_ACCESS = ['read-only', 'read-write', 'destructive'] as const;
export const TOOL_PERMISSION = ['auto', 'session_consent', 'always_confirm'] as const;
export const TOOL_TYPES = ['builtin', 'function', 'loader'] as const;

export type ToolAccess = (typeof TOOL_ACCESS)[number];
export type ToolPermission = (typeof TOOL_PERMISSION)[number];
export type { ToolLoadTier };
export { TOOL_LOAD_TIERS };

export interface ToolLabels {
  activity?: string;
  activityPast?: string;
  hiddenFromSettings?: boolean;
}

export interface ToolBase {
  name: string;
  description: string;
  category: string;
  access: ToolAccess;
  paths: string[];
  loadTier: ToolLoadTier;
  permission: ToolPermission;
  labels?: ToolLabels;
}

export interface BuiltinWire {
  interactions?: string;
  openRouter?: string;
  live?: string;
}

export interface BuiltinToolDef extends ToolBase {
  type: 'builtin';
  wire: BuiltinWire;
  conflictsWith?: string[];
  /** When enabled, select the paid Gemini vault slot unless model.spec.key overrides. */
  forcePaidKey?: boolean;
}

export interface InteractiveRender {
  kind: string;
  prompt: string;
  options?: string[];
  [key: string]: unknown;
}

export interface InteractiveConfig<TIn = unknown> {
  render: (input: TIn) => InteractiveRender;
}

export interface InvokeToolResume {
  value?: unknown;
  granted?: boolean;
}

export interface ToolContext {
  profile: Profile;
  callId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  turn?: { step: number };
  resume?: InvokeToolResume;
}

export interface ToolFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolPause {
  kind: 'interactive' | 'confirmation' | 'permission';
  tool: string;
  render?: InteractiveRender;
  summary?: string;
  input: unknown;
  permission?: ToolPermission;
}

export interface ToolWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface ToolTraceStep {
  name: string;
  kind: string;
  status: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export type ToolStreamEvent<TOut = unknown> =
  | { kind: 'progress'; data: unknown }
  | { kind: 'trace'; step: ToolTraceStep }
  | { kind: 'artifact'; artifact: unknown }
  | { kind: 'warning'; warning: ToolWarning }
  | { kind: 'complete'; output: TOut };

export type SyncToolHandler<TIn, TOut> = (input: TIn, ctx: ToolContext) => TOut | Promise<TOut>;
export type StreamToolHandler<TIn, TOut> = (
  input: TIn,
  ctx: ToolContext,
) => AsyncGenerator<ToolStreamEvent<TOut>>;

export type ToolHandler<TIn, TOut> = SyncToolHandler<TIn, TOut> | StreamToolHandler<TIn, TOut>;

export interface FunctionToolDef<TIn = unknown, TOut = unknown> extends ToolBase {
  type: 'function';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  handler: ToolHandler<TIn, TOut>;
  interactive?: InteractiveConfig<TIn>;
  canExecute?: (input: TIn, ctx: ToolContext) => boolean | Promise<boolean>;
  preflight?: (
    input: TIn,
    ctx: ToolContext,
  ) => undefined | ToolFailure | ToolPause | Promise<undefined | ToolFailure | ToolPause>;
  exposeToModel?: boolean;
  /** Set at registration when the handler is an async generator. */
  handlerStreams?: boolean;
}

export interface LoaderToolDef extends ToolBase {
  type: 'loader';
  input: z.ZodType<unknown>;
  output: z.ZodType<unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  resolve: (
    input: unknown,
    ctx: ToolContext,
  ) => { loaded: string[] } | Promise<{ loaded: string[] }>;
}

export type RegisteredTool = BuiltinToolDef | FunctionToolDef | LoaderToolDef;

export type ToolDefinitionInput =
  | Omit<BuiltinToolDef, never>
  | (Omit<FunctionToolDef, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType;
      output: z.ZodType;
    })
  | (Omit<LoaderToolDef, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType;
      output: z.ZodType;
    });

export interface WireFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnToolState {
  builtins: ToolId[];
  /** Tool ids gated on for this turn (allow + path + tools[id] === true). */
  gated: ToolId[];
  /** Schemas sent to the provider (respects loadTier + loader promotion). */
  visible: ToolId[];
  /** Kernel-executable tools: gated, visible, and loaded (excludes builtins). */
  executable: ToolId[];
  path?: string;
  sessionPermissions?: string[];
}

export interface TurnToolSnapshot extends TurnToolState {
  wire: WireFunctionTool[];
}

/** Context for turn-time T1 tool selection via `TurnRequest.toolLoader`. */
export interface ToolLoadContext {
  profile: Profile;
  input?: TurnInput;
  path?: string;
  sessionPermissions?: string[];
  /** Tool ids gated on this turn. */
  gated: ToolId[];
}

export type TurnToolLoader = (ctx: ToolLoadContext) => ToolId[] | Promise<ToolId[]>;

export interface InvokeToolRequest {
  profile: string;
  name: string;
  input: unknown;
  /**
   * Turn opt-in gates (same as `TurnRequest.tools`). Required for direct invoke
   * unless `resume` continues a paused call (see `InvokeToolResume`).
   */
  tools?: Partial<Record<ToolId, boolean>>;
  /** Turn input context for `toolLoader` selection (same as `TurnRequest.input`). */
  turnInput?: TurnInput;
  /** T1 tool selection — same contract as `TurnRequest.toolLoader`. */
  toolLoader?: TurnToolLoader;
  /**
   * T2 tools already promoted for this invoke (e.g. restored from pause metadata).
   * Host must have run a loader or equivalent policy before listing ids here.
   */
  promoted?: ToolId[];
  /** Model select key — same as `TurnRequest.select` (builtins resolve from that model). */
  select?: string;
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
}

export interface ProfileToolsSpec {
  /** Custom function/loader tools this profile may run. Builtins live on model specs. */
  allow: ToolId[];
}

export interface ModelToolResult {
  finding: string;
  data?: unknown;
}

export type ToolCallPhase =
  | 'running'
  | 'progress'
  | 'trace'
  | 'artifact'
  | 'warning'
  | 'complete'
  | 'pause'
  | 'error';

export interface ToolCallEvent {
  name: string;
  /** Provider-native id or kernel-assigned call id. */
  callId?: string;
  arguments?: Record<string, unknown>;
  /** Absent on raw provider tool-call events; set by kernel execution. */
  phase?: ToolCallPhase;
  data?: unknown;
  step?: ToolTraceStep;
  artifact?: unknown;
  warning?: ToolWarning;
  output?: unknown;
  pause?: ToolPause;
  failure?: ToolFailure;
}
