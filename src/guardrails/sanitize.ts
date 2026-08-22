import { mapStrings } from '../kernel/engine/tree.ts';
import { getProfile } from '../kernel/registry/profiles.ts';
import type { TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { sanitizeTurnBlobsForProfile } from '../providers/attachments.ts';
import { injectionSpans } from './injection.ts';
import { sensitiveSpans } from './sensitive.ts';

function sanitizeText(
  text: string,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): string {
  const sanitizeInput = options?.sanitizeInput ?? true;
  const redactSensitive = options?.redactSensitive ?? true;
  if (!sanitizeInput && !redactSensitive) {
    return text;
  }
  const spans = [
    ...(sanitizeInput ? injectionSpans(text) : []),
    ...(redactSensitive ? sensitiveSpans(text) : []),
  ];
  return applySpans(text, spans);
}

function sanitizeSlots(
  slots: Record<string, string> | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): Record<string, string> | undefined {
  if (!slots) {
    return slots;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    out[key] = sanitizeText(value, options);
  }
  return out;
}

function sanitizeArgs(
  args: Record<string, unknown>,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): Record<string, unknown> {
  const next = mapStrings(args, (t) => sanitizeText(t, options));
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    return next as Record<string, unknown>;
  }
  return args;
}

const PROJECT_ID_MAX = 128;
const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

function sanitizeProjectId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const trimmed = id.trim().slice(0, PROJECT_ID_MAX);
  if (!PROJECT_ID_OK.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function sanitizeFix(
  fix: import('../kernel/types.ts').TurnFixRequest | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): import('../kernel/types.ts').TurnFixRequest | undefined {
  if (!fix) {
    return fix;
  }
  return {
    artifact: sanitizeText(fix.artifact, options),
    error: sanitizeText(fix.error, options),
    guidance: fix.guidance ? sanitizeText(fix.guidance, options) : undefined,
  };
}

function sanitizeHistory(
  history: import('../kernel/types.ts').TurnHistoryMessage[] | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): import('../kernel/types.ts').TurnHistoryMessage[] | undefined {
  if (!history) {
    return history;
  }
  return history.map((m) => ({
    role: m.role,
    ...(m.content !== undefined ? { content: sanitizeText(m.content, options) } : {}),
    ...(m.parts
      ? {
          parts: m.parts.map((p) =>
            p.type === 'text' ? { ...p, text: sanitizeText(p.text, options) } : p,
          ),
        }
      : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.metadata ? { metadata: m.metadata } : {}),
  }));
}

function sanitizeTurnRequest(req: TurnRequest): TurnRequest {
  let profileGuardrails: { sanitizeInput?: boolean; redactSensitive?: boolean } | undefined;
  try {
    profileGuardrails = getProfile(req.profile)?.guardrails;
  } catch {
    // If profile not registered yet, default to full guardrails
  }
  const options = {
    sanitizeInput: profileGuardrails?.sanitizeInput ?? true,
    redactSensitive: profileGuardrails?.redactSensitive ?? true,
  };

  const { input, toolInvoke } = req;
  const { text: rawText } = input;
  let invoke = toolInvoke;
  if (toolInvoke) {
    invoke = { ...toolInvoke, arguments: sanitizeArgs(toolInvoke.arguments, options) };
  }
  let text = rawText;
  if (rawText !== undefined) {
    text = sanitizeText(rawText, options);
  }
  let system = req.system;
  if (system !== undefined) {
    system = sanitizeText(system, options);
  }
  const { attachments, voice } = sanitizeTurnBlobsForProfile(
    req.profile,
    input.attachments,
    input.voice,
  );
  return {
    ...req,
    system,
    projectId: sanitizeProjectId(req.projectId),
    input: {
      ...input,
      text,
      slots: sanitizeSlots(input.slots, options),
      attachments,
      voice,
      fix: sanitizeFix(input.fix, options),
      history: sanitizeHistory(input.history, options),
    },
    toolInvoke: invoke,
  };
}

export { PROJECT_ID_MAX, sanitizeProjectId, sanitizeText, sanitizeTurnRequest };
