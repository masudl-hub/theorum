import { assertEquals, assertThrows } from '@std/assert';
import {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from '../../src/kernel/registry/profiles.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { modelAllow } from '../fixtures/models.ts';

registerGooglePreset();

Deno.test('defineProfile creates valid defaults', () => {
  const profile = defineProfile({
    id: 'host_profile',
    model: { ...modelAllow('gemini35FlashLite'), thinking: 'low' },
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
  assertEquals(profile.outputs.image, undefined);
  assertEquals(profile.outputs.speech, undefined);
  assertEquals(profile.guardrails.canary, true);
  assertEquals(profile.guardrails.quota, undefined);
});

Deno.test('defineProfile defaults all optional host-authored sections', () => {
  const profile = defineProfile({
    id: 'bare_host_profile',
    model: { ...modelAllow('gemini35FlashLite') },
  });

  assertEquals(profile.identity.handle, 'bare_host_profile');
  assertEquals(profile.model.thinking, 'minimal');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs.image, undefined);
  assertEquals(profile.guardrails.sanitizeInput, true);
});

Deno.test('registerProfile accepts minimal host-authored profile definitions', () => {
  registerProfile({
    id: 'minimal_host_bot',
    model: { ...modelAllow('gemini35FlashLite') },
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
    model: { ...modelAllow('gemini35FlashLite') },
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
    model: { ...modelAllow('gemini35FlashLite') },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10 } },
  });
  const p2 = defineProfile({
    id: 'bot_beta',
    model: { ...modelAllow('gemini35FlashLite') },
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
    model: { ...modelAllow('gemini35FlashLite') },
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

Deno.test('clearProfiles empties the process-local registry', () => {
  const prior = listProfiles();
  registerProfile({
    id: 'temp_clear_bot',
    model: { ...modelAllow('gemini35FlashLite') },
  });
  assertEquals(hasProfile('temp_clear_bot'), true);
  clearProfiles();
  assertEquals(listProfiles().length, 0);
  for (const profile of prior) {
    registerProfile(profile);
  }
  assertEquals(hasProfile('temp_clear_bot'), false);
});
