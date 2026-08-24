import { assertEquals } from '@std/assert';
import { registerStructured } from '../../src/kernel/registry/schemas.ts';
import type { ProviderCompleteRequest } from '../../src/kernel/types.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import {
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from '../../src/providers/openrouter-payload.ts';
import { HOST_MODELS } from '../fixtures/models.ts';

registerGooglePreset();

Deno.test('resolveOpenRouterModel handles custom mapping, catalog models, and fallback', () => {
  const flashLite = HOST_MODELS.gemini35FlashLite;
  // Custom map
  assertEquals(
    resolveOpenRouterModel('gemini35FlashLite', { gemini35FlashLite: 'anthropic/claude-3-haiku' }),
    'anthropic/claude-3-haiku',
  );

  // Wire ids from host model spec
  assertEquals(
    resolveOpenRouterModel('gemini35FlashLite', undefined, { apiId: flashLite.apiId }),
    'google/gemini-3.5-flash-lite',
  );

  // Fallback
  assertEquals(resolveOpenRouterModel('custom-model-id'), 'custom-model-id');
});

Deno.test('toOpenRouterPayload tests all modalities, tools, thinking, structured schemas, and history formats', () => {
  // Register schema without jsonSchema
  registerStructured('noSchemaStructured', {
    enforced: 'prompt',
  });

  const baseReq: ProviderCompleteRequest = {
    model: 'gemini35FlashLite',
    apiId: HOST_MODELS.gemini35FlashLite.apiId,
    system: 'You are an assistant',
    summaries: 'auto',
    image: null,
    geminiBucket: 'freeA',
    input: [
      { type: 'text', text: 'Hello text' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'audio', mimeType: 'audio/wav', data: 'UklGRi===' },
      { type: 'audio', mimeType: 'audio/mp3', data: 'SUQzBA===' },
      { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0=' },
    ],
    history: [
      {
        role: 'user',
        content: 'plain user message',
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'part 1' },
          { type: 'text', text: 'part 2' },
        ],
      },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'calculator', arguments: '{"expr":"1+1"}' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'calculator',
        tool_call_id: 'call_1',
        content: '2',
      },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'listen to this' },
          { type: 'audio', mimeType: 'audio/wav', data: 'UklGRi===' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0=' },
        ],
      },
    ],
    thinking: 'medium',
    maxOutputTokens: 2048,
    temperature: 0.7,
    builtins: ['googleSearch'],
    dynamicTools: [
      {
        name: 'bareTool',
      },
      {
        name: 'fullTool',
        description: 'A full tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ],
    structured: 'noSchemaStructured',
  };

  const payload = toOpenRouterPayload(baseReq, {});

  assertEquals(payload.model, 'google/gemini-3.5-flash-lite');
  assertEquals(payload.stream, true);
  assertEquals(payload.temperature, 0.7);
  assertEquals(payload.max_tokens, 2048);
  assertEquals(payload.reasoning, { effort: 'medium' });
  assertEquals(payload.plugins, [{ id: 'web' }]);
  assertEquals(payload.response_format, undefined); // because noSchemaStructured has no jsonSchema

  const tools = payload.tools as Array<{
    type: string;
    function: { name: string; description: string; parameters: unknown };
  }>;
  assertEquals(tools.length, 2);
  assertEquals(tools[0].function.name, 'bareTool');
  assertEquals(tools[0].function.description, '');
  assertEquals(tools[0].function.parameters, { type: 'object', properties: {} });
  assertEquals(tools[1].function.name, 'fullTool');
  assertEquals(tools[1].function.description, 'A full tool');
});
