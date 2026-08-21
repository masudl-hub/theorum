import { assertEquals, assertExists } from 'jsr:@std/assert@^1.0.0';
import { listProfilesCommand, showProfileCommand } from '../../src/cli/commands/profile.ts';
import { vaultStatusCommand } from '../../src/cli/commands/vault.ts';
import {
  FIXTURE_PNG_BASE64,
  FIXTURE_WAV_BASE64,
  getFixtureForMime,
} from '../../src/cli/matrix/fixtures.ts';
import {
  buildCustomTurnRequest,
  synthesizeLiteCombo,
  synthesizeMatrixCombos,
  synthesizeStressCombo,
} from '../../src/cli/matrix/synthesizer.ts';
import {
  dailyProfile,
  mermaidProfile,
  plannerProfile,
  registerBuiltinProfiles,
  studioProfile,
} from '../../src/kernel/registry/builtin-profiles.ts';
import { getProfile } from '../../src/kernel/registry/profiles.ts';
import type { Profile } from '../../src/kernel/types.ts';

const testProfile: Profile = {
  id: 'test-agent',
  identity: { handle: 'test-agent', system: 'You are a test agent.' },
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    key: 'portfolio',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: ['image/png', 'application/pdf'] },
    voice: { accept: ['audio/wav'] },
    maxFiles: 5,
    maxBytes: 10_000_000,
    maxTurnBytes: 15_000_000,
  },
  outputs: { structured: null, media: false },
  guardrails: { quota: { perDay: 50 } },
};

Deno.test('fixtures produce valid base64 buffers', () => {
  assertExists(FIXTURE_PNG_BASE64);
  assertExists(FIXTURE_WAV_BASE64);

  const png = getFixtureForMime('image/png');
  assertEquals(png?.mimeType, 'image/png');
  assertEquals(png?.data, FIXTURE_PNG_BASE64);

  const pdf = getFixtureForMime('application/pdf');
  assertEquals(pdf?.mimeType, 'application/pdf');

  const wav = getFixtureForMime('audio/wav');
  assertEquals(wav?.mimeType, 'audio/wav');
});

Deno.test('synthesizeLiteCombo constructs minimal fast request', () => {
  const req = synthesizeLiteCombo(testProfile);
  assertEquals(req.profile, 'test-agent');
  assertEquals(req.select, 'fast');
  assertEquals(req.input.attachments, undefined);
  assertEquals(req.input.voice, undefined);
});

Deno.test('synthesizeStressCombo constructs smart mode with multimodal attachments and enforces search XOR maps', () => {
  const req = synthesizeStressCombo(testProfile);
  assertEquals(req.profile, 'test-agent');
  assertEquals(req.select, 'smart');
  assertEquals(req.input.attachments?.length, 1);
  assertEquals(req.input.voice?.length, 1);

  // By default, search is enabled and maps is disabled
  assertEquals(req.tools?.googleSearch, true);
  assertEquals(req.tools?.googleMaps, false);
});

Deno.test('synthesizeStressCombo supports preferMaps override', () => {
  const req = synthesizeStressCombo(testProfile, { preferMaps: true });
  assertEquals(req.tools?.googleSearch, false);
  assertEquals(req.tools?.googleMaps, true);
});

Deno.test('synthesizeMatrixCombos generates all key permutations', () => {
  const matrix = synthesizeMatrixCombos(testProfile);
  assertEquals(matrix.length, 3);
  assertEquals(matrix[0].name, 'Lite (connectivity)');
  assertEquals(matrix[1].name, 'Stress (all modalities + primary tools)');
  assertEquals(matrix[2].name, 'Maps Variant (maps enabled, search off)');
});

Deno.test('buildCustomTurnRequest respects explicit CLI flag overrides', () => {
  const req = buildCustomTurnRequest(testProfile, {
    mode: 'fast',
    map: true,
  });
  assertEquals(req.select, 'fast');
  assertEquals(req.tools?.googleMaps, true);
  assertEquals(req.tools?.googleSearch, false);
});

Deno.test('builtin profiles register and commands render cards', () => {
  registerBuiltinProfiles();
  assertEquals(getProfile('mermaid').id, mermaidProfile.id);
  assertEquals(getProfile('studio').id, studioProfile.id);
  assertEquals(getProfile('planner').id, plannerProfile.id);
  assertEquals(getProfile('daily').id, dailyProfile.id);

  listProfilesCommand();
  showProfileCommand('mermaid');
  showProfileCommand('non_existent');
  vaultStatusCommand();
});
