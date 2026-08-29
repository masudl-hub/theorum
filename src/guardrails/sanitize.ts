/**
 * Request sanitization utilities for THEORUM.
 *
 * Sanitization removes inbound prompt-injection spans and sensitive-data spans
 * according to the active profile guardrail flags. The host remains responsible
 * for domain policy.
 *
 * @module
 */

import { mapStrings } from '../kernel/engine/tree.ts';
import { sanitizeTurnBlobsForProfile } from '../kernel/registry/attachments.ts';
import { getProfile } from '../kernel/registry/profiles.ts';
import type { DynamicToolDeclaration, NormalizedTurnRequest, TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { injectionSpans } from './injection.ts';
import { sensitiveSpans } from './sensitive.ts';

/** Sanitize one text value using prompt-injection and sensitive-data detectors. */
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

/** Redact only sensitive data (credentials, PII) — skip injection patterns.
 *  Use for model output text that never contained user-authored injection attempts. */
function redactSensitiveOnly(text: string): string {
  const spans = sensitiveSpans(text);
  if (spans.length === 0) return text;
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

/** Maximum retained length for trace-safe host project ids. */
const PROJECT_ID_MAX = 128;
const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

/** Return a trace-safe project id or `undefined` when the input is unsafe. */
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

function sanitizeRepair(
  repair: import('../kernel/types.ts').TurnRepairRequest | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): import('../kernel/types.ts').TurnRepairRequest | undefined {
  if (!repair) {
    return repair;
  }
  return {
    previousOutput: sanitizeText(repair.previousOutput, options),
    rejection: sanitizeText(repair.rejection, options),
    guidance: repair.guidance ? sanitizeText(repair.guidance, options) : undefined,
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

function sanitizeDynamicTool(
  decl: DynamicToolDeclaration,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): DynamicToolDeclaration {
  const clean = { ...decl };
  if (clean.description !== undefined) {
    clean.description = sanitizeText(clean.description, options);
  }
  if (clean.parameters !== undefined) {
    clean.parameters = sanitizeArgs(clean.parameters, options) as Record<string, unknown>;
  }
  return clean;
}

/** Sanitize description and parameter schema text in dynamic tool declarations. */
function sanitizeDynamicTools(
  tools: DynamicToolDeclaration[] | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): DynamicToolDeclaration[] | undefined {
  if (!tools || tools.length === 0) {
    return tools;
  }
  return tools.map((decl) => sanitizeDynamicTool(decl, options));
}

/** Sanitize all user-controlled text and blobs in a turn request. */
function sanitizeTurnRequest(req: TurnRequest): NormalizedTurnRequest {
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

  const input = req.input ?? {};
  const { toolInvoke } = req;
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
    dynamicTools: sanitizeDynamicTools(req.dynamicTools, options),
    input: {
      ...input,
      text,
      slots: sanitizeSlots(input.slots, options),
      attachments,
      voice,
      repair: sanitizeRepair(input.repair, options),
      history: sanitizeHistory(input.history, options),
    },
    toolInvoke: invoke,
  };
}

export {
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeDynamicTools,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
};
