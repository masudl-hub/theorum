import { mapStrings } from '../kernel/engine/tree.ts';
import type { TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { sanitizeTurnBlobsForProfile } from '../providers/attachments.ts';
import { injectionSpans } from './injection.ts';
import { sensitiveSpans } from './sensitive.ts';

function sanitizeText(text: string): string {
  return applySpans(text, [...injectionSpans(text), ...sensitiveSpans(text)]);
}

function sanitizeSlots(
  slots: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!slots) {
    return slots;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    out[key] = sanitizeText(value);
  }
  return out;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = mapStrings(args, sanitizeText);
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
): import('../kernel/types.ts').TurnFixRequest | undefined {
  if (!fix) {
    return fix;
  }
  return {
    artifact: sanitizeText(fix.artifact),
    error: sanitizeText(fix.error),
    guidance: fix.guidance ? sanitizeText(fix.guidance) : undefined,
  };
}

function sanitizeHistory(
  history: import('../kernel/types.ts').TurnHistoryMessage[] | undefined,
): import('../kernel/types.ts').TurnHistoryMessage[] | undefined {
  if (!history) {
    return history;
  }
  return history.map((m) => ({
    role: m.role,
    content: sanitizeText(m.content),
  }));
}

function sanitizeTurnRequest(req: TurnRequest): TurnRequest {
  const { input, toolInvoke } = req;
  const { text: rawText } = input;
  let invoke = toolInvoke;
  if (toolInvoke) {
    invoke = { ...toolInvoke, arguments: sanitizeArgs(toolInvoke.arguments) };
  }
  let text = rawText;
  if (rawText !== undefined) {
    text = sanitizeText(rawText);
  }
  const { attachments, voice } = sanitizeTurnBlobsForProfile(
    req.profile,
    input.attachments,
    input.voice,
  );
  return {
    ...req,
    projectId: sanitizeProjectId(req.projectId),
    input: {
      ...input,
      text,
      slots: sanitizeSlots(input.slots),
      attachments,
      voice,
      fix: sanitizeFix(input.fix),
      history: sanitizeHistory(input.history),
    },
    toolInvoke: invoke,
  };
}

export { PROJECT_ID_MAX, sanitizeProjectId, sanitizeText, sanitizeTurnRequest };
