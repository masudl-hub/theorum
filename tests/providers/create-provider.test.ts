import '../fixtures/enable-test-internals.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { createProvider } from '../../src/providers/create-provider.ts';
import { testInternals } from '../fixtures/testInternals.js';

const { isSpeechRole, isImageRole } = testInternals('create-provider');

function baseProfile(
  model: { protocol: 'geminiInteractions' | 'openAi'; provider: string },
  role: 'chat' | 'speech' | 'image',
): Profile {
  const outputs =
    role === 'speech'
      ? { structured: null, speech: { voice: 'Kore', format: 'pcm' as const } }
      : role === 'image'
        ? {
            structured: null,
            image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/png' },
          }
        : { structured: null };
  return {
    id: 'test-profile',
    identity: { handle: 'test' },
    model: { ...model, allow: [], config: {} },
    tools: { allow: [] },
    inputs: {},
    outputs,
    guardrails: { quota: { perDay: 1 } },
  } as unknown as Profile;
}

Deno.test('isSpeechRole is true when outputs.speech is defined', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'speech');
  assertEquals(isSpeechRole(profile), true);
});

Deno.test('isSpeechRole is false when outputs.speech is undefined', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'chat');
  assertEquals(isSpeechRole(profile), false);
});

Deno.test('isImageRole is true when outputs.image is defined', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'image');
  assertEquals(isImageRole(profile), true);
});

Deno.test('isImageRole is false when outputs.image is undefined', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'chat');
  assertEquals(isImageRole(profile), false);
});

Deno.test('createProvider throws when gemini transport is missing for geminiInteractions/google', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'chat');
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
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'chat');
  const provider = createProvider(profile, {
    gemini: { vault: { freeA: 'a', freeB: 'b', freeC: 'c', paid: 'p' } },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws when openAiGateway config is missing for openAi/openrouter', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'chat');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider requires openAiGateway config for openAi/openrouter',
  );
});

Deno.test('createProvider returns a chat provider for openAi/openrouter non-speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'chat');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider returns an image provider for openAi/openrouter image profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'image');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws for openAi/local image profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'image');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider: outputs.image requires openrouter provider for openAi protocol',
  );
});

Deno.test('createProvider returns a speech provider for openAi/openrouter speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'speech');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key', voice: 'Kore' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws for unsupported protocol/provider pairs', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'google' }, 'chat');
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
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'chat');
  const provider = createProvider(profile, {});
  assertEquals(typeof provider.complete, 'function');
  const withUrl = createProvider(profile, { local: { baseUrl: 'http://127.0.0.1:8080' } });
  assertEquals(typeof withUrl.complete, 'function');
});

Deno.test('create-provider has no eager adapter imports', async () => {
  const src = await Deno.readTextFile(
    new URL('../../src/providers/create-provider.ts', import.meta.url),
  );
  assertEquals(/from\s+['"]\.\/openrouter\//.test(src), false);
  assertEquals(/from\s+['"]\.\/local\/local\.ts['"]/.test(src), false);
  assertEquals(/from\s+['"]\.\/google\/interactions\//.test(src), false);
  assertEquals(/from\s+['"]\.\/google\/live\//.test(src), false);
  assertEquals(src.includes("import('./openrouter/chat.ts')"), true);
  assertEquals(src.includes("import('./google/interactions/mod.ts')"), true);
  assertEquals(src.includes("import('./google/live/mod.ts')"), true);
  assertEquals(src.includes("import('./openrouter/speech.ts')"), true);
  assertEquals(src.includes("import('./openrouter/image.ts')"), true);
  assertEquals(src.includes("import('./local/local.ts')"), true);
});

Deno.test('create-provider loads OpenRouter adapter only via dynamic import', async () => {
  // Sync createProvider for openrouter chat must not touch the Vercel graph.
  // This file's suite runs without --allow-sys; an eager openrouter import would throw.
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'chat');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('create-provider loads Google adapter only via dynamic import', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'chat');
  const provider = createProvider(profile, {
    gemini: { vault: { freeA: 'a', freeB: 'b', freeC: 'c', paid: 'p' } },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('create-provider loads local adapter only via dynamic import', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'chat');
  const provider = createProvider(profile, {});
  assertEquals(typeof provider.complete, 'function');
});
