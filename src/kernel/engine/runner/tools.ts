import { toErrorEvent } from '../../../guardrails/error.ts';
import { sanitizeDynamicTools, sanitizeText } from '../../../guardrails/sanitize.ts';
import { CATALOG } from '../../registry/catalog.ts';
import { executeTool } from '../../registry/tools.ts';
import type {
  CustomToolId,
  DynamicToolDeclaration,
  Profile,
  ResolvedGeneration,
  ToolEnvelope,
  ToolId,
  TurnEvent,
  TurnRequest,
} from '../../types.ts';

function formatToolFinding(res: ToolEnvelope): string {
  let raw: string;
  if (res.finding) {
    raw = res.finding;
  } else if (res.data) {
    raw = JSON.stringify(res.data);
  } else {
    return 'ok';
  }
  return sanitizeText(raw);
}

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
      yield toErrorEvent(formatToolFinding(result));
      return;
    }
    yield { type: 'done' };
  } catch (err) {
    yield toErrorEvent(err);
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
    const events: TurnEvent[] = [
      {
        type: 'tool',
        tool: { name, arguments: args, result },
      },
    ];
    if (result.status === 'error') {
      events.push(toErrorEvent(formatToolFinding(result)));
    }
    return events;
  } catch (err) {
    return [toErrorEvent(err)];
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
    return [toErrorEvent(`Tool '${name}' is not gated on this turn`)];
  }
  const args = tool.arguments ?? {};
  return executeCustomModelTool(profile, name as CustomToolId, args);
}

function findDynamicDeclaration(
  tools: DynamicToolDeclaration[] | undefined,
  name: string,
): DynamicToolDeclaration | undefined {
  return tools?.find((t) => t.name === name);
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
    const decision = await decl.canExecute({
      args,
      profile,
      sessionPermissions,
    });
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
    return {
      status: 'error',
      finding: `Authorization error for '${decl.name}': ${msg}`,
    };
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
    return {
      status: 'ok',
      finding: `${decl.name} accepted (no handler)`,
      data: args,
    };
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
  const rawLoaded = await loader({
    name: decl.name,
    args: toolArgs,
    profile,
    currentTools: generation.dynamicTools ?? [],
    sessionPermissions: generation.sessionPermissions,
  });
  const loaded = sanitizeDynamicTools(rawLoaded) ?? [];
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
    return await executeDynamicToolLoader({
      decl,
      toolArgs,
      profile,
      generation,
    });
  }
  return res;
}

export {
  dispatchModelTool,
  executeDynamicDeclaration,
  findDynamicDeclaration,
  formatToolFinding,
  invokeFromUi,
  isActionableDynamicDeclaration,
};
