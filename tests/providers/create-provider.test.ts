import '../fixtures/enable-test-internals.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { createProvider } from '../../src/providers/create-provider.ts';
import { testInternals } from '../fixtures/testInternals.js';

const { isSpeechRole } = testInternals('create-provider');

function baseProfile(
  model: { protocol: 'geminiInteractions' | 'openAi'; provider: string },
  speech: boolean,
): Profile {
  return {
    id: 'test-profile',
    identity: { handle: 'test' },
    model: { ...model, allow: [], config: {} },
    tools: { allow: [] },
    inputs: {},
    outputs: speech
      ? { structured: null, speech: { voice: 'Kore', format: 'pcm' } }
      : { structured: null },
    guardrails: { quota: { perDay: 1 } },
  } as unknown as Profile;
}

Deno.test('isSpeechRole is true when outputs.speech is defined', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, true);
  assertEquals(isSpeechRole(profile), true);
});

Deno.test('isSpeechRole is false when outputs.speech is undefined', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, false);
  assertEquals(isSpeechRole(profile), false);
});

Deno.test('createProvider throws when gemini transport is missing for geminiInteractions/google', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, false);
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider requires gemini transport for google Interactions',
  );
});

Deno.test('createProvider returns a provider when gemini transport is supplied', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, false);
  const provider = createProvider(profile, {
    gemini: { vault: { freeA: 'a', freeB: 'b', freeC: 'c', paid: 'p' } },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws when openRouter config is missing for openAi/openrouter', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, false);
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider requires openRouter config for openAi/openrouter',
  );
});

Deno.test('createProvider returns a chat provider for openAi/openrouter non-speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, false);
  const provider = createProvider(profile, { openRouter: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider returns a speech provider for openAi/openrouter speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, true);
  const provider = createProvider(profile, { openRouter: { apiKey: 'key', voice: 'Kore' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws for unsupported protocol/provider pairs', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'google' }, false);
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    "createProvider: unsupported protocol/provider pair 'openAi'/'google'",
  );
});

Deno.test('createProvider routes openAi/local without requiring options.local', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, false);
  const provider = createProvider(profile, {});
  assertEquals(typeof provider.complete, 'function');
  const withUrl = createProvider(profile, { local: { baseUrl: 'http://127.0.0.1:8080' } });
  assertEquals(typeof withUrl.complete, 'function');
});

Deno.test('create-provider loads OpenRouter adapter only via dynamic import', async () => {
  const src = await Deno.readTextFile(
    new URL('../../src/providers/create-provider.ts', import.meta.url),
  );
  assertEquals(/from\s+['"]\.\/openrouter\.ts['"]/.test(src), false);
  assertEquals(src.includes("import('./openrouter.ts')"), true);
  // Sync createProvider for openrouter chat must not touch the Vercel graph.
  // This file's suite runs without --allow-sys; an eager openrouter import would throw.
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, false);
  const provider = createProvider(profile, { openRouter: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});
