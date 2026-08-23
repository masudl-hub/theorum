/**
 * Generic built-in custom tool executor.
 *
 * Static custom tools are intentionally minimal. Application-specific tools
 * should be supplied as dynamic declarations with host-owned handlers.
 *
 * @module
 */

import type { CustomToolId, Profile, ToolEnvelope } from '../types.ts';
import { CATALOG } from './catalog.ts';
import { assertToolAllowed } from './resolve.ts';

function executeAskUser(args: Record<string, unknown>): ToolEnvelope {
  const { kind, prompt } = args;
  if (kind !== 'confirm' && kind !== 'choice' && kind !== 'text') {
    return { status: 'error', finding: 'askUser.kind must be confirm, choice, or text' };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 'error', finding: 'askUser.prompt is required' };
  }
  return {
    status: 'pause',
    finding: prompt,
    data: { ...args, schema: CATALOG.tools.askUser.schema },
  };
}

/** Execute a static tool after enforcing the profile allowlist. */
function executeTool(
  profile: Profile,
  name: CustomToolId,
  args: Record<string, unknown>,
): ToolEnvelope {
  assertToolAllowed(profile, name);
  if (name === 'askUser') {
    return executeAskUser(args);
  }
  return {
    status: 'error',
    finding: `Tool '${name}' has no kernel executor; pass a dynamic tool handler instead.`,
  };
}

export { executeTool };
