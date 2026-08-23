import { assertEquals, assertThrows } from '@std/assert';
import {
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from '../../src/kernel/registry/profiles.ts';

Deno.test('defineProfile creates valid defaults', () => {
  const profile = defineProfile({
    id: 'host_profile',
    model: { allow: ['gemini35FlashLite'], thinking: 'low' },
  });

  assertEquals(profile.id, 'host_profile');
  assertEquals(profile.model.protocol, 'geminiInteractions');
  assertEquals(profile.model.provider, 'google');
  assertEquals(profile.model.maxSteps, 1);
  assertEquals(profile.model.key, 'freeA');
  assertEquals(profile.identity.handle, 'host_profile');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs.structured, null);
  assertEquals(profile.outputs.media, false);
  assertEquals(profile.guardrails.canary, true);
  assertEquals(profile.guardrails.quota, undefined);
});

Deno.test('defineProfile defaults all optional host-authored sections', () => {
  const profile = defineProfile({
    id: 'bare_host_profile',
    model: { allow: ['gemini35FlashLite'] },
  });

  assertEquals(profile.identity.handle, 'bare_host_profile');
  assertEquals(profile.model.thinking, 'minimal');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs.media, false);
  assertEquals(profile.guardrails.sanitizeInput, true);
});

Deno.test('registerProfile accepts minimal host-authored profile definitions', () => {
  registerProfile({
    id: 'minimal_host_bot',
    model: { allow: ['gemini35FlashLite'] },
  });

  const profile = getProfile('minimal_host_bot');
  assertEquals(profile.identity.handle, 'minimal_host_bot');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs.structured, null);
  assertEquals(profile.guardrails.quota, undefined);
});

Deno.test('registerProfile and getProfile manage runtime profile lifecycle', () => {
  const profile = defineProfile({
    id: 'custom_bot',
    model: { allow: ['gemini35FlashLite'] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 50 } },
  });

  registerProfile(profile);
  assertEquals(hasProfile('custom_bot'), true);
  assertEquals(getProfile('custom_bot').id, 'custom_bot');
  assertEquals(
    listProfiles().some((p) => p.id === 'custom_bot'),
    true,
  );
});

Deno.test('registerProfiles handles batch registration', () => {
  const p1 = defineProfile({
    id: 'bot_alpha',
    model: { allow: ['gemini35FlashLite'] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10 } },
  });
  const p2 = defineProfile({
    id: 'bot_beta',
    model: { allow: ['gemini35FlashLite'] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 20 } },
  });

  registerProfiles([p1, p2]);
  assertEquals(hasProfile('bot_alpha'), true);
  assertEquals(hasProfile('bot_beta'), true);
});

Deno.test('registerProfile validates media limits if attachments are enabled', () => {
  const invalidProfile = defineProfile({
    id: 'invalid_media_bot',
    model: { allow: ['gemini35FlashLite'] },
    inputs: { text: true, attachments: { accept: ['image/png'] } },
    guardrails: { quota: { perDay: 10 } },
  });

  assertThrows(
    () => {
      registerProfile(invalidProfile);
    },
    Error,
    'must set maxFiles, maxBytes, and maxTurnBytes',
  );
});

Deno.test('getProfile throws for unknown profile', () => {
  assertThrows(
    () => {
      getProfile('non_existent_profile');
    },
    Error,
    "Unknown profile 'non_existent_profile'",
  );
});
