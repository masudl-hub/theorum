import {
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheorumError,
  UPSTREAM_FAILED,
} from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('publicError never leaks keys, HTTP codes, or stack text', () => {
  assertEquals(publicError(new TheorumError(UPSTREAM_FAILED)), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheorumError('empty Gemini stream')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('Gemini HTTP 500'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new Error('ECONNREFUSED 127.0.0.1')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheorumError('canary leaked')), PUBLIC_CANARY);
  assertEquals(publicError("Tool 'askUser' is not gated on this turn"), PUBLIC_ACTION);
  assertEquals(
    publicError(new TheorumError("MIME 'image/gif' is not accepted on mermaid")),
    "That file type isn't supported.",
  );
  assertEquals(
    publicError(new TheorumError('Profile pinned does not accept voice')),
    "That file type isn't supported.",
  );
  const wire = [
    publicError(new TheorumError('GEMINI_API_KEY_STUDIO not configured')),
    publicError('Gemini HTTP 429'),
    publicError(new Error('fetch failed: dns')),
  ].join(' ');
  assertEquals(wire.includes('GEMINI'), false);
  assertEquals(wire.includes('429'), false);
  assertEquals(wire.includes('dns'), false);
  assertEquals(
    publicError(new TheorumError('Only 5 files per message.')),
    'Only 5 files per message.',
  );
});
