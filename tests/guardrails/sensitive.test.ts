import {
  TEST_AWS_KEY,
  TEST_OPENAI_KEY,
  TEST_SSN,
  TEST_VISA,
} from '../../src/guardrails/corpus/secrets.ts';
import { sensitiveSpans } from '../../src/guardrails/sensitive.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('sensitiveSpans detects SSN and API keys from corpus secrets', () => {
  assertEquals(sensitiveSpans(`SSN: ${TEST_SSN}`).length > 0, true);
  assertEquals(sensitiveSpans(`key ${TEST_OPENAI_KEY}`).length > 0, true);
  assertEquals(sensitiveSpans(`AWS ${TEST_AWS_KEY}1`).length > 0, true);
});

Deno.test('sensitiveSpans detects Luhn-valid card numbers', () => {
  assertEquals(sensitiveSpans(`Card: ${TEST_VISA}`).length > 0, true);
});

Deno.test('sensitiveSpans ignores benign prose', () => {
  assertEquals(sensitiveSpans('Please summarize the quarterly report.').length, 0);
});

Deno.test('sensitiveSpans detects spaced and dashed card formats', () => {
  assertEquals(sensitiveSpans('4111 1111 1111 1111').length > 0, true);
  assertEquals(sensitiveSpans('4111.1111.1111.1111').length > 0, true);
});

Deno.test('sensitiveSpans detects all credential pattern types', () => {
  const samples: Array<[string, string]> = [
    ['itin', '912-34-5678'],
    ['ein', '12-3456789'],
    ['iban', 'DE89370400440532013000'],
    ['ipv6', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'],
    ['github-pat', 'github_pat_11AAAAAAA_1234567890123456789012345'],
    ['github-token', 'ghp_' + 'A'.repeat(36)],
    ['slack', 'xoxb-123456789012-1234567890123-abcde'],
    ['bearer', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEo\n-----END RSA PRIVATE KEY-----'],
    ['anthropic', 'sk-ant-api03-' + 'x'.repeat(24)],
    ['openrouter', 'sk-or-' + 'x'.repeat(25)],
    ['openai', 'sk-' + 'x'.repeat(24)],
    ['google', 'AIza' + 'x'.repeat(35)],
    ['aws', 'AKIAIOSFODNN7EXAMPLE123'],
    ['ipv4', '10.0.0.1'],
    ['ssn', '078-05-1120'],
    ['ssn-contextual', 'SSN: 123456789'],
  ];
  for (const [, value] of samples) {
    const spans = sensitiveSpans(value);
    assertEquals(spans.length > 0, true);
  }
});

Deno.test('sensitiveSpans rejects Luhn-invalid card numbers', () => {
  assertEquals(sensitiveSpans('4111111111111112').length, 0);
});

Deno.test('sensitiveSpans detects multiple cards in a single string', () => {
  assertEquals(sensitiveSpans('4111111111111111 and 5500005555555559').length, 2);
});

Deno.test('sensitiveSpans ignores digit sequences below minimum card length', () => {
  assertEquals(sensitiveSpans('411111111111').length, 0);
});
