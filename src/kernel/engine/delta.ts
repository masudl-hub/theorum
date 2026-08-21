import type { TurnEvent, TurnTokens } from '../types.ts';
import { asRecord } from './record.ts';

function deltaText(delta: Record<string, unknown>): string {
  if (typeof delta.text === 'string') {
    return delta.text;
  }
  const { content } = delta;
  if (typeof content === 'string') {
    return content;
  }
  const nested = asRecord(content);
  if (nested && typeof nested.text === 'string') {
    return nested.text;
  }
  return '';
}

function deltaMedia(delta: Record<string, unknown>): TurnEvent | undefined {
  const mimeType = delta.mimeType ?? delta.mime_type;
  const { data } = delta;
  if (typeof mimeType === 'string' && typeof data === 'string' && data) {
    return { type: 'media', media: { mimeType, data } };
  }
  return undefined;
}

function eventIfText(type: 'thought' | 'text', delta: Record<string, unknown>): TurnEvent[] {
  const text = deltaText(delta);
  if (!text) {
    return [];
  }
  return [{ type, text }];
}

function eventsFromImage(delta: Record<string, unknown>): TurnEvent[] {
  const media = deltaMedia(delta);
  if (media) {
    return [media];
  }
  return [];
}

function eventsFromDelta(deltaValue: unknown): TurnEvent[] {
  const delta = asRecord(deltaValue);
  if (!delta) {
    return [];
  }
  const deltaType = String(delta.type ?? '');
  if (deltaType === 'thought_summary' || deltaType === 'thought') {
    return eventIfText('thought', delta);
  }
  if (deltaType === 'text') {
    return eventIfText('text', delta);
  }
  if (deltaType === 'image') {
    return eventsFromImage(delta);
  }
  return [];
}

function mediaFromRecord(rec: Record<string, unknown>): TurnEvent | undefined {
  const mimeType = rec.mimeType ?? rec.mime_type;
  const { data } = rec;
  if (typeof mimeType === 'string' && typeof data === 'string' && data) {
    return { type: 'media', media: { mimeType, data } };
  }
  return undefined;
}

function mediaFromOutputItem(item: unknown): TurnEvent | undefined {
  const rec = asRecord(item);
  if (!rec) {
    return undefined;
  }
  if (rec.type !== 'image' && rec.type !== 'media') {
    return undefined;
  }
  return mediaFromRecord(rec);
}

function mediaFromOutputs(outputs: unknown): TurnEvent | undefined {
  if (!Array.isArray(outputs)) {
    return undefined;
  }
  for (const item of outputs) {
    const media = mediaFromOutputItem(item);
    if (media) {
      return media;
    }
  }
  return undefined;
}

function mediaFromComplete(event: Record<string, unknown>): TurnEvent | undefined {
  const interaction = asRecord(event.interaction) ?? event;
  const direct = asRecord(interaction.output_image);
  if (direct) {
    const media = mediaFromRecord(direct);
    if (media) {
      return media;
    }
  }
  return mediaFromOutputs(interaction.outputs);
}

const INPUT_KEYS = [
  'total_input_tokens',
  'totalInputTokens',
  'prompt_token_count',
  'promptTokenCount',
  'prompt_tokens',
  'input_tokens',
  'inputTokens',
  'input',
] as const;

const OUTPUT_KEYS = [
  'total_output_tokens',
  'totalOutputTokens',
  'candidates_token_count',
  'candidatesTokenCount',
  'candidates_tokens',
  'completion_tokens',
  'output_tokens',
  'outputTokens',
  'output',
] as const;

const THINKING_KEYS = [
  'total_thought_tokens',
  'totalThoughtTokens',
  'thoughts_token_count',
  'thoughtsTokenCount',
  'thoughts_tokens',
  'thinking_tokens',
  'thinkingTokens',
  'thinking',
] as const;

const TOOL_KEYS = [
  'total_tool_use_tokens',
  'totalToolUseTokens',
  'tool_use_token_count',
  'toolUseTokenCount',
  'tool_tokens',
  'toolTokens',
  'toolUse',
] as const;

const TOTAL_KEYS = [
  'total_tokens',
  'totalTokens',
  'total_token_count',
  'totalTokenCount',
  'total',
] as const;

function pickNumericField(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const val = record[key];
    if (val !== undefined && val !== null) {
      const n = Number(val);
      if (!Number.isNaN(n)) {
        return n;
      }
    }
  }
  return 0;
}

function extractUsageTokens(raw: unknown): TurnTokens | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const input = pickNumericField(r, INPUT_KEYS);
  const output = pickNumericField(r, OUTPUT_KEYS);
  const thinking = pickNumericField(r, THINKING_KEYS);
  const toolUse = pickNumericField(r, TOOL_KEYS);
  const total = pickNumericField(r, TOTAL_KEYS) || input + output + thinking + toolUse;
  if (input > 0 || output > 0 || thinking > 0 || toolUse > 0 || total > 0) {
    return { input, output, thinking, toolUse, total };
  }
  return undefined;
}

const USAGE_KEYS = ['usage', 'usage_metadata', 'usageMetadata'] as const;

function findUsageObject(target: Record<string, unknown>, event: Record<string, unknown>): unknown {
  for (const key of USAGE_KEYS) {
    if (target[key]) return target[key];
  }
  for (const key of USAGE_KEYS) {
    if (event[key]) return event[key];
  }
  return undefined;
}

function extractTokenEvent(
  event: Record<string, unknown>,
  interaction?: Record<string, unknown>,
): TurnEvent | undefined {
  const target = interaction ?? asRecord(event.interaction) ?? event;
  const usage = extractUsageTokens(findUsageObject(target, event));
  const interactionId = typeof target.id === 'string' ? target.id : undefined;
  if (!usage) {
    return undefined;
  }
  return {
    type: 'tokens',
    tokens: usage,
    ...(interactionId ? { interactionId } : {}),
  };
}

function eventsFromComplete(event: Record<string, unknown>, alreadyText: boolean): TurnEvent[] {
  const interaction = asRecord(event.interaction) ?? event;
  const outputText = interaction.output_text;
  const events: TurnEvent[] = [];
  if (!alreadyText && typeof outputText === 'string' && outputText) {
    events.push({ type: 'text', text: outputText });
  }
  const media = mediaFromComplete(event);
  if (media) {
    events.push(media);
  }
  const tokenEvent = extractTokenEvent(event, interaction);
  if (tokenEvent) {
    events.push(tokenEvent);
  }
  return events;
}

function tryStructured(text: string): TurnEvent | undefined {
  try {
    return { type: 'structured', structured: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export {
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  extractUsageTokens,
  tryStructured,
};
