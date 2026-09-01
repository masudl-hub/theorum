import '../../../fixtures/enable-test-internals.ts';
import '../../../../src/providers/openrouter/openai/compat.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import { testInternals } from '../../../fixtures/testInternals.js';

const { openAiGatewayHeaders, parseToolInput, fallbackToolCallId, stringDefault } =
  testInternals('openai/compat');

Deno.test('openAiGatewayHeaders returns undefined when no site info', () => {
  assertEquals(openAiGatewayHeaders({}), undefined);
});

Deno.test('openAiGatewayHeaders sets HTTP-Referer for siteUrl', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://app.com' });
  assertEquals(headers?.['HTTP-Referer'], 'https://app.com');
  assertEquals(headers?.['X-Title'], undefined);
});

Deno.test('openAiGatewayHeaders sets X-Title for siteName', () => {
  const headers = openAiGatewayHeaders({ siteName: 'MyApp' });
  assertEquals(headers?.['X-Title'], 'MyApp');
  assertEquals(headers?.['HTTP-Referer'], undefined);
});

Deno.test('openAiGatewayHeaders sets both headers', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://a.com', siteName: 'A' });
  assertEquals(headers?.['HTTP-Referer'], 'https://a.com');
  assertEquals(headers?.['X-Title'], 'A');
});

Deno.test('parseToolInput parses valid JSON', () => {
  assertEquals(parseToolInput('{"a":1}'), { a: 1 });
});

Deno.test('parseToolInput wraps invalid JSON', () => {
  assertEquals(parseToolInput('not json'), { _raw: 'not json' });
});

Deno.test('stringDefault uses fallback for undefined', () => {
  assertEquals(stringDefault(undefined, 'fb'), 'fb');
  assertEquals(stringDefault('val', 'fb'), 'val');
  assertEquals(stringDefault('', 'fb'), '');
});

Deno.test('fallbackToolCallId generates ID from name', () => {
  assertEquals(fallbackToolCallId('search'), 'call_search');
  assertEquals(fallbackToolCallId(undefined), 'call_tool');
});
