import {
  errorMessage,
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_FILE_COUNT,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_TYPE,
  PUBLIC_GENERIC,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheorumError,
  UPSTREAM_FAILED,
} from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('publicError and errorMessage cover all exact mappings and rules', () => {
  assertEquals(errorMessage(new TheorumError(UPSTREAM_FAILED)), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheorumError('empty Gemini stream')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('Gemini HTTP 500'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('OpenRouter HTTP 401'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('TTS HTTP 503'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new Error('ECONNREFUSED 127.0.0.1')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheorumError('canary leaked')), PUBLIC_CANARY);
  assertEquals(
    publicError(new TheorumError('Turn withheld: egress disclosure violation')),
    PUBLIC_CANARY,
  );
  assertEquals(
    publicError(new TheorumError('expected JSON object')),
    'Something was wrong with that request.',
  );
  assertEquals(
    publicError(new TheorumError('user input cannot be placed in the system block')),
    PUBLIC_GENERIC,
  );
  assertEquals(publicError(new TheorumError('attachment data must be base64')), PUBLIC_FILE_TYPE);
  assertEquals(publicError(new TheorumError('attachment is too large')), PUBLIC_FILE_SIZE);
  assertEquals(
    publicError(new TheorumError('attachments exceed the per-turn budget')),
    PUBLIC_FILE_SIZE,
  );
  assertEquals(
    publicError(new TheorumError('askUser.kind must be confirm, choice, or text')),
    "That question isn't valid.",
  );
  assertEquals(
    publicError(new TheorumError('askUser.prompt is required')),
    'That question needs a prompt.',
  );
  assertEquals(
    publicError(new TheorumError('This profile does not accept text input')),
    PUBLIC_ACTION,
  );

  assertEquals(publicError("Tool 'askUser' is not gated on this turn"), PUBLIC_ACTION);
  assertEquals(publicError("Tool 'googleSearch' is not allowed on this profile"), PUBLIC_ACTION);
  assertEquals(publicError("Tool 'hostTool' has no kernel executor"), PUBLIC_ACTION);
  assertEquals(publicError("Unknown model select 'ultra'"), PUBLIC_ACTION);
  assertEquals(publicError('Grounding tools conflict'), PUBLIC_ACTION);

  assertEquals(
    publicError(new TheorumError("MIME 'image/gif' is not accepted on host-profile")),
    PUBLIC_FILE_TYPE,
  );
  assertEquals(
    publicError(new TheorumError('Profile pinned does not accept voice')),
    PUBLIC_FILE_TYPE,
  );
  assertEquals(publicError(new TheorumError('At most 5 files are allowed')), PUBLIC_FILE_COUNT);
  assertEquals(
    publicError(new TheorumError('Each file must be under 2MB')),
    'Each file must be under 2MB',
  );
  assertEquals(
    publicError(new TheorumError('Those files together are too large')),
    'Those files together are too large',
  );
  assertEquals(publicError(new TheorumError('Invalid aspect or size')), PUBLIC_IMAGE_SIZE);
  assertEquals(publicError(new TheorumError('Profile must pin thinking')), PUBLIC_GENERIC);
  assertEquals(publicError(new TheorumError('Profile has no models')), PUBLIC_GENERIC);

  const wire = [
    publicError(new TheorumError('host key slot not configured')),
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
