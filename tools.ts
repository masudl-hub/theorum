import { CATALOG } from './catalog.ts';
import { assertHandoffTarget, assertToolAllowed } from './resolve.ts';
import type { CustomToolId, Profile, ToolEnvelope } from './types.ts';

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

function executeHandoff(profile: Profile, args: Record<string, unknown>): ToolEnvelope {
  const { to, prompt: rawPrompt } = args;
  if (typeof to !== 'string') {
    return { status: 'error', finding: 'handoff.to is required' };
  }
  assertHandoffTarget(profile, to);
  let prompt = '';
  if (typeof rawPrompt === 'string') {
    prompt = rawPrompt;
  }
  return { status: 'ok', finding: `handoff to ${to}`, data: { to, prompt } };
}

function executeTool(
  profile: Profile,
  name: CustomToolId,
  args: Record<string, unknown>,
): ToolEnvelope {
  assertToolAllowed(profile, name);
  if (name === 'askUser') {
    return executeAskUser(args);
  }
  if (name === 'handoff') {
    return executeHandoff(profile, args);
  }
  if (name === 'generateMedia') {
    return {
      status: 'error',
      finding: 'generateMedia is not wired; enable it on the profile when a media backend exists',
    };
  }
  return { status: 'ok', finding: `${name} accepted (stub)`, data: args };
}

export { executeTool };
