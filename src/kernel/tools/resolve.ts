/**
 * Turn tool visibility and wire snapshot resolution.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import type { ModelId, Profile, ToolId, TurnRequest } from '../types.ts';
import { getTool } from './registry.ts';
import type { TurnToolSnapshot, TurnToolLoader, WireFunctionTool } from './types.ts';

function pathMatches(catalogPaths: string[], turnPath?: string): boolean {
  if (catalogPaths.includes('*')) {
    return true;
  }
  if (!turnPath) {
    return false;
  }
  return catalogPaths.includes(turnPath);
}

function isGatedOn(requested: Partial<Record<ToolId, boolean>> | undefined, id: ToolId): boolean {
  if (!requested) {
    return false;
  }
  return requested[id] === true;
}

function applyBuiltinMutualExclusions(requested: string[]): string[] {
  return requested.filter((id) => {
    const tool = getTool(id);
    if (tool?.type !== 'builtin') {
      return true;
    }
    const conflicts = tool.conflictsWith ?? [];
    return !conflicts.some((other) => requested.includes(other));
  });
}

function resolveGatedCustomToolIds(profile: Profile, req: TurnRequest): ToolId[] {
  return profile.tools.allow.filter((id) => {
    const tool = getTool(id);
    if (!tool || tool.type === 'builtin') {
      return false;
    }
    if (!pathMatches(tool.paths, req.path)) {
      return false;
    }
    return isGatedOn(req.tools, id);
  });
}

function resolveGatedBuiltinIds(profile: Profile, req: TurnRequest, modelId: ModelId): ToolId[] {
  const spec = profile.model.config[modelId];
  if (!spec) {
    return [];
  }
  return spec.builtInTools.filter((id) => {
    const tool = getTool(id);
    if (tool?.type !== 'builtin') {
      return false;
    }
    if (!pathMatches(tool.paths, req.path)) {
      return false;
    }
    return isGatedOn(req.tools, id);
  });
}

function wireForTool(name: string): WireFunctionTool | undefined {
  const tool = getTool(name);
  if (!tool || tool.type === 'builtin') {
    return undefined;
  }
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function buildWire(visible: ToolId[]): WireFunctionTool[] {
  const out: WireFunctionTool[] = [];
  for (const id of visible) {
    const wire = wireForTool(id);
    if (wire) {
      out.push(wire);
    }
  }
  return out;
}

function promoteTool(state: TurnToolSnapshot, id: ToolId): void {
  if (state.visible.includes(id)) {
    return;
  }
  state.visible.push(id);
  const wire = wireForTool(id);
  if (wire && !state.wire.some((w) => w.name === id)) {
    state.wire.push(wire);
  }
}

function promoteBuiltin(state: TurnToolSnapshot, id: ToolId): void {
  if (state.builtins.includes(id)) {
    return;
  }
  const tool = getTool(id);
  if (tool?.type !== 'builtin') {
    return;
  }
  const conflicts = tool.conflictsWith ?? [];
  state.builtins = state.builtins.filter((existing) => {
    if (conflicts.includes(existing)) {
      return false;
    }
    const existingTool = getTool(existing);
    return !(existingTool?.type === 'builtin' && existingTool.conflictsWith?.includes(id));
  });
  state.builtins.push(id);
}

function initialVisible(gated: ToolId[]): ToolId[] {
  return gated.filter((id) => getTool(id)?.loadTier === 'T0');
}

function initialBuiltins(gated: ToolId[]): ToolId[] {
  return applyBuiltinMutualExclusions(
    gated.filter((id) => {
      const tool = getTool(id);
      return tool?.type === 'builtin' && tool.loadTier === 'T0';
    }),
  );
}

/** Build the initial tool snapshot for a turn (T0 wired; T1/T2 pending). */
function resolveTurnTools(profile: Profile, req: TurnRequest, modelId: ModelId): TurnToolSnapshot {
  const customGated = resolveGatedCustomToolIds(profile, req);
  const builtinGated = resolveGatedBuiltinIds(profile, req, modelId);
  const gated = [...customGated, ...builtinGated];
  const builtins = initialBuiltins(gated);
  const visible = initialVisible(gated);
  const executable = visible.filter((id) => getTool(id)?.type !== 'builtin');
  return {
    builtins,
    gated,
    visible,
    executable,
    path: req.path,
    sessionPermissions: req.sessionPermissions,
    wire: buildWire(visible),
  };
}

/** Resolve T0 snapshot and expand T1 selections from `TurnRequest.toolLoader`. */
async function prepareTurnToolSnapshot(
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId,
): Promise<TurnToolSnapshot> {
  const snapshot = resolveTurnTools(profile, req, modelId);
  await expandTurnToolLoader(snapshot, profile, req);
  return snapshot;
}

/** Wire T1 tools selected by the host toolLoader. */
async function expandTurnToolLoader(
  state: TurnToolSnapshot,
  profile: Profile,
  req: TurnRequest,
): Promise<void> {
  const loader: TurnToolLoader | undefined = req.toolLoader;
  if (!loader) {
    return;
  }
  const selected = await loader({
    profile,
    input: req.input,
    path: req.path,
    sessionPermissions: req.sessionPermissions,
    gated: state.gated,
  });
  for (const id of selected) {
    if (!state.gated.includes(id)) {
      continue;
    }
    const tool = getTool(id);
    if (!tool || tool.loadTier !== 'T1') {
      continue;
    }
    if (tool.type === 'builtin') {
      promoteBuiltin(state, id);
    } else {
      promoteTool(state, id);
    }
  }
  state.executable = state.visible.filter((id) => getTool(id)?.type !== 'builtin');
}

/** Promote T2 tools into the visible set after a loader resolves. Returns ids actually promoted. */
function promoteLoadedTools(state: TurnToolSnapshot, loaded: string[], profile: Profile): string[] {
  const promoted: string[] = [];
  for (const id of loaded) {
    if (!profile.tools.allow.includes(id)) {
      throw new TheorumError(`Loader attempted to promote tool '${id}' outside profile allow`);
    }
    const tool = getTool(id);
    if (!tool) {
      throw new TheorumError(`Loader attempted to promote unknown tool '${id}'`);
    }
    if (tool.type === 'builtin') {
      throw new TheorumError(`Loader attempted to promote builtin '${id}' — only custom tools may be loader-promoted`);
    }
    if (tool.loadTier !== 'T2') {
      throw new TheorumError(
        `Loader attempted to promote tool '${id}' with loadTier '${tool.loadTier}' — only T2 tools may be loader-promoted`,
      );
    }
    if (!pathMatches(tool.paths, state.path)) {
      continue;
    }
    if (!state.gated.includes(id)) {
      continue;
    }
    promoteTool(state, id);
    promoted.push(id);
  }
  state.executable = state.visible.filter((id) => getTool(id)?.type !== 'builtin');
  return promoted;
}

export {
  expandTurnToolLoader,
  prepareTurnToolSnapshot,
  promoteLoadedTools,
  resolveTurnTools,
};
