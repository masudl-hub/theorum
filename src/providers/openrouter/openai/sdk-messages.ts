/**
 * Convert THEORUM turn input into Vercel AI SDK `ModelMessage[]`.
 *
 * Semantic twin of `openai/compat.ts` (REST wire format). OpenRouter's AI SDK
 * adapter uses this module; local and payload paths use `buildChatMessages`.
 *
 * @module
 */

import type { ModelMessage } from 'ai';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
} from '../../../kernel/types.ts';
import { exposeForTests } from '../../expose-for-tests.ts';
import { fallbackToolCallId, parseToolInput } from './compat.ts';

function stringDefault(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value;
}

function sdkPart(part: InteractionPart): Record<string, unknown> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    return {
      type: 'image',
      image: `data:${part.mimeType};base64,${part.data}`,
    };
  }
  return { type: 'file', mediaType: part.mimeType, data: part.data };
}

function sdkContentFromParts(parts: InteractionPart[]): string | Array<Record<string, unknown>> {
  if (parts.every((part) => part.type === 'text')) {
    return parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return parts.map(sdkPart);
}

function sdkContentFromOptionalParts(
  parts: InteractionPart[] | undefined,
  text: string | undefined,
): string | Array<Record<string, unknown>> {
  if (!parts || parts.length === 0) {
    return stringDefault(text, '');
  }
  return sdkContentFromParts(parts);
}

function toolResultMessage(msg: TurnHistoryMessage): ModelMessage {
  const toolName = stringDefault(msg.name, 'tool');
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: stringDefault(msg.tool_call_id, fallbackToolCallId(msg.name)),
        toolName,
        output: { type: 'text', value: stringDefault(msg.content, '') },
      },
    ],
  } as unknown as ModelMessage;
}

function assistantToolCallMessage(msg: TurnHistoryMessage): ModelMessage | null {
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return null;
  }
  return {
    role: 'assistant',
    content: msg.tool_calls.map((call) => ({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseToolInput(call.function.arguments),
    })),
  } as ModelMessage;
}

function contentHistoryMessage(msg: TurnHistoryMessage): ModelMessage {
  const content = sdkContentFromOptionalParts(msg.parts, msg.content);
  return { role: msg.role, content } as ModelMessage;
}

function historyToSdk(msg: TurnHistoryMessage): ModelMessage | null {
  if (msg.role === 'tool') {
    return toolResultMessage(msg);
  }
  return assistantToolCallMessage(msg) || contentHistoryMessage(msg);
}

/**
 * Build AI SDK messages for history + user input.
 * Caller supplies `req.system` via `streamText({ instructions })`.
 */
function buildAiSdkMessages(req: ProviderCompleteRequest): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const msg of req.history ?? []) {
    const wired = historyToSdk(msg);
    if (wired) {
      messages.push(wired);
    }
  }
  if (req.input.length > 0) {
    messages.push({ role: 'user', content: sdkContentFromParts(req.input) } as ModelMessage);
  }
  return messages;
}

export { buildAiSdkMessages };

exposeForTests('openai/sdk-messages', {
  sdkPart,
  sdkContentFromParts,
  sdkContentFromOptionalParts,
  toolResultMessage,
  assistantToolCallMessage,
  contentHistoryMessage,
  historyToSdk,
  buildAiSdkMessages,
  stringDefault,
});
