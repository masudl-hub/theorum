/**
 * Host-initiated tool execution entrypoint.
 *
 * @module
 */

import { getProfile } from '../registry/profiles.ts';
import { pickModel } from '../registry/resolve.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { executeRegisteredTool, newCallId } from './execute.ts';
import { prepareTurnToolSnapshot, promoteLoadedTools } from './resolve.ts';
import type { InvokeToolRequest } from './types.ts';

function turnRequestFromInvoke(request: InvokeToolRequest): TurnRequest {
  return {
    profile: request.profile,
    tools: request.tools,
    path: request.path,
    sessionPermissions: request.sessionPermissions,
    input: request.turnInput,
    toolLoader: request.toolLoader,
    select: request.select,
  };
}

async function snapshotForInvoke(
  request: InvokeToolRequest,
  profile: Profile,
): Promise<Awaited<ReturnType<typeof prepareTurnToolSnapshot>>> {
  const req = turnRequestFromInvoke(request);
  const model = pickModel(profile, request.select);
  const snapshot = await prepareTurnToolSnapshot(profile, req, model);
  if (request.promoted?.length) {
    promoteLoadedTools(snapshot, request.promoted, profile);
  }
  return snapshot;
}

/** Execute a registered tool without calling a model provider. */
async function* invokeTool(request: InvokeToolRequest): AsyncGenerator<TurnEvent> {
  const profile = getProfile(request.profile);
  const callId = newCallId(request.name);
  const snapshot = await snapshotForInvoke(request, profile);
  let sawPause = false;
  let sawError = false;
  for await (const event of executeRegisteredTool({
    profile,
    name: request.name,
    input: request.input,
    callId,
    ctx: {
      sessionPermissions: request.sessionPermissions,
      path: request.path,
      signal: request.signal,
      resume: request.resume,
    },
    snapshot,
  })) {
    yield event;
    if (event.type !== 'tool') {
      continue;
    }
    if (event.tool?.phase === 'pause') {
      sawPause = true;
    }
    if (event.tool?.phase === 'error') {
      sawError = true;
    }
  }
  const stopKind = sawError || sawPause ? 'tool' : 'completed';
  yield { type: 'done', stop: { kind: stopKind } };
}

export { invokeTool };
