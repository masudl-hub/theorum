import type { GroundingEvent, GroundingSource, TurnEvent, TurnTokens } from '../types.ts';
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

function sourceFromMaps(maps: Record<string, unknown>): GroundingSource | undefined {
  const uri = maps.uri ?? maps.googleMapsUri ?? maps.google_maps_uri;
  if (typeof uri !== 'string' || !uri) {
    return undefined;
  }
  const title = maps.title ?? maps.name;
  return {
    type: 'maps',
    uri,
    title: typeof title === 'string' && title ? title : uri,
  };
}

function sourceFromWeb(web: Record<string, unknown>): GroundingSource | undefined {
  const uri = web.uri;
  if (typeof uri !== 'string' || !uri) {
    return undefined;
  }
  const title = web.title ?? web.domain;
  return {
    type: 'web',
    uri,
    title: typeof title === 'string' && title ? title : uri,
  };
}

function pushUniqueSource(sources: GroundingSource[], source: GroundingSource | undefined): void {
  if (!source) {
    return;
  }
  if (!sources.some((item) => item.uri === source.uri && item.type === source.type)) {
    sources.push(source);
  }
}

function groundingChunks(metadata: Record<string, unknown>): unknown[] {
  const chunks = metadata.groundingChunks ?? metadata.grounding_chunks;
  if (Array.isArray(chunks)) {
    return chunks;
  }
  return [];
}

function searchHtml(metadata: Record<string, unknown>): string | undefined {
  const searchEntryPoint = asRecord(metadata.searchEntryPoint ?? metadata.search_entry_point);
  const renderedContent = searchEntryPoint?.renderedContent ?? searchEntryPoint?.rendered_content;
  if (typeof renderedContent === 'string' && renderedContent.trim()) {
    return renderedContent;
  }
  return undefined;
}

function sourcesFromChunks(chunks: unknown[]): GroundingSource[] {
  const sources: GroundingSource[] = [];
  for (const chunk of chunks) {
    const record = asRecord(chunk);
    if (!record) {
      continue;
    }
    const maps = asRecord(record.maps);
    if (maps) {
      pushUniqueSource(sources, sourceFromMaps(maps));
    }
    const web = asRecord(record.web);
    if (web) {
      pushUniqueSource(sources, sourceFromWeb(web));
    }
  }
  return sources;
}

function mergeGrounding(
  a: GroundingEvent | undefined,
  b: GroundingEvent | undefined,
): GroundingEvent | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const chunks = [...(a.chunks ?? []), ...(b.chunks ?? [])];
  const sources = [...a.sources];
  for (const source of b.sources) {
    pushUniqueSource(sources, source);
  }
  return {
    metadata: b.metadata ?? a.metadata,
    ...(chunks.length > 0 ? { chunks } : {}),
    searchHtml: b.searchHtml ?? a.searchHtml,
    sources,
  };
}

function groundingFromMetadata(metadataValue: unknown): GroundingEvent | undefined {
  const metadata = asRecord(metadataValue);
  if (!metadata) {
    return undefined;
  }
  const chunks = groundingChunks(metadata);
  const sources = sourcesFromChunks(chunks);
  const html = searchHtml(metadata);
  if (chunks.length === 0 && sources.length === 0 && !html) {
    return { metadata, sources };
  }
  return {
    metadata,
    ...(chunks.length > 0 ? { chunks } : {}),
    ...(html ? { searchHtml: html } : {}),
    sources,
  };
}

function groundingMetadataFromRecord(record: Record<string, unknown>): unknown {
  return record.groundingMetadata ?? record.grounding_metadata;
}

function groundingFromStep(stepValue: unknown): GroundingEvent | undefined {
  const step = asRecord(stepValue);
  if (!step) {
    return undefined;
  }
  let grounding = groundingFromMetadata(groundingMetadataFromRecord(step));
  const content = step.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      grounding = mergeGrounding(
        grounding,
        groundingFromMetadata(groundingMetadataFromRecord(asRecord(block) ?? {})),
      );
    }
  }
  return grounding;
}

function groundingFromEvent(event: Record<string, unknown>): TurnEvent | undefined {
  let grounding = groundingFromMetadata(groundingMetadataFromRecord(event));
  grounding = mergeGrounding(grounding, groundingFromStep(event.step));
  grounding = mergeGrounding(grounding, groundingFromStep(event.delta));
  const interaction = asRecord(event.interaction);
  if (interaction) {
    grounding = mergeGrounding(
      grounding,
      groundingFromMetadata(groundingMetadataFromRecord(interaction)),
    );
  }
  const steps = interaction?.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      grounding = mergeGrounding(grounding, groundingFromStep(step));
    }
  }
  if (!grounding) {
    return undefined;
  }
  return { type: 'grounding', grounding };
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
  const groundingEvent = groundingFromEvent(event);
  if (groundingEvent) {
    events.push(groundingEvent);
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
  groundingFromEvent,
  tryStructured,
};
