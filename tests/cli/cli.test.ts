import { assertEquals, assertExists } from '@std/assert';
import { listProfilesCommand, showProfileCommand } from '../../src/cli/commands/profile.ts';
import { runCommand } from '../../src/cli/commands/run.ts';
import { executeSingleTest, testProfileCommand } from '../../src/cli/commands/test.ts';
import { vaultPingCommand, vaultStatusCommand } from '../../src/cli/commands/vault.ts';
import { main } from '../../src/cli/index.ts';
import {
  FIXTURE_CSV_BASE64,
  FIXTURE_PDF_BASE64,
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
import type { ModelProvider, Profile, TurnEvent } from '../../src/kernel/types.ts';

const testProfile: Profile = {
  id: 'test-agent',
  identity: { handle: 'test-agent', system: 'You are a test agent.' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    key: 'portfolio',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: ['image/png', 'application/pdf', 'text/csv', 'text/plain'] },
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
  assertExists(FIXTURE_PDF_BASE64);
  assertExists(FIXTURE_CSV_BASE64);

  const png = getFixtureForMime('image/png');
  assertEquals(png?.mimeType, 'image/png');
  assertEquals(png?.data, FIXTURE_PNG_BASE64);

  const pdf = getFixtureForMime('application/pdf');
  assertEquals(pdf?.mimeType, 'application/pdf');

  const csv = getFixtureForMime('text/csv');
  assertEquals(csv?.mimeType, 'text/csv');

  const txt = getFixtureForMime('text/plain');
  assertEquals(txt?.mimeType, 'text/plain');

  const wav = getFixtureForMime('audio/wav');
  assertEquals(wav?.mimeType, 'audio/wav');

  const unknown = getFixtureForMime('unknown/mime');
  assertEquals(unknown, undefined);
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
    search: false,
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

Deno.test('vaultPingCommand exercises active, failed, error, and skipped paths', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvStudio = Deno.env.get('GEMINI_API_KEY_STUDIO');
  const originalEnvPlanner = Deno.env.get('GEMINI_API_KEY_PLANNER');
  const originalEnvPortfolio = Deno.env.get('GEMINI_API_KEY_PORTFOLIO');
  const originalEnvPaid = Deno.env.get('GEMINI_API_KEY');
  const originalEnvOpenRouter = Deno.env.get('OPENROUTER_API_KEY');

  try {
    Deno.env.set('GEMINI_API_KEY_STUDIO', 'AIzaSyTestStudioKey123456789');
    Deno.env.set('GEMINI_API_KEY_PLANNER', 'AIzaSyTestPlannerKey123456789');
    Deno.env.set('GEMINI_API_KEY_PORTFOLIO', 'short');
    Deno.env.delete('GEMINI_API_KEY');
    Deno.env.set('OPENROUTER_API_KEY', 'sk-or-test123456789');

    // Mock fetch for Google & OpenRouter endpoints
    globalThis.fetch = (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('StudioKey')) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }
      if (urlStr.includes('PlannerKey')) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 403 }));
      }
      if (urlStr.includes('openrouter.ai')) {
        return Promise.reject(new Error('Network offline'));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    };

    vaultStatusCommand();
    await vaultPingCommand();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnvStudio) Deno.env.set('GEMINI_API_KEY_STUDIO', originalEnvStudio);
    else Deno.env.delete('GEMINI_API_KEY_STUDIO');
    if (originalEnvPlanner) Deno.env.set('GEMINI_API_KEY_PLANNER', originalEnvPlanner);
    else Deno.env.delete('GEMINI_API_KEY_PLANNER');
    if (originalEnvPortfolio) Deno.env.set('GEMINI_API_KEY_PORTFOLIO', originalEnvPortfolio);
    else Deno.env.delete('GEMINI_API_KEY_PORTFOLIO');
    if (originalEnvPaid) Deno.env.set('GEMINI_API_KEY', originalEnvPaid);
    else Deno.env.delete('GEMINI_API_KEY');
    if (originalEnvOpenRouter) Deno.env.set('OPENROUTER_API_KEY', originalEnvOpenRouter);
    else Deno.env.delete('OPENROUTER_API_KEY');
  }
});

Deno.test('runCommand exercises all stream event types and failure handling', async () => {
  const mockEvents: TurnEvent[] = [
    { type: 'thought', text: 'Thinking step...' },
    { type: 'text', text: 'Hello human!' },
    { type: 'tool', tool: { name: 'calculator', arguments: { expr: '2+2' } } },
    { type: 'structured', structured: { result: 4 } },
    { type: 'media', media: { mimeType: 'image/png', data: 'abc' } },
    { type: 'error', error: 'Non-fatal error' },
    { type: 'done' },
  ];

  const mockProvider: ModelProvider = {
    async *complete() {
      for (const ev of mockEvents) {
        yield ev;
      }
    },
  };

  // Run with mock provider via executeSingleTest
  const res = await executeSingleTest(
    { profile: 'mermaid', input: { text: 'test' } },
    'Mermaid Event Stream Test',
    mockProvider,
  );
  assertEquals(res.passed, false); // because error event was yielded

  // Run runCommand directly
  await runCommand({
    profile: 'mermaid',
    prompt: 'Create diagram',
    search: true,
    map: true,
  });
});

Deno.test('testProfileCommand and CLI main router test flag parsing and commands', async () => {
  registerBuiltinProfiles();

  // Test profile commands via main()
  await main(['profile', 'list']);
  await main(['profile', 'show', 'mermaid']);
  await main(['profile', 'show', '--profile', 'planner']);
  await main(['vault', 'status']);
  await main(['vault', 'unknown']);
  await main(['help']);
  await main(['--help']);
  await main(['-h']);
  await main(['run', '-p', 'mermaid', 'generate', 'a', 'chart']);

  // Invalid profile
  const failedRes = await testProfileCommand('non_existent');
  assertEquals(failedRes, false);

  // Missing profile
  const noProfileRes = await testProfileCommand(undefined, { all: false });
  assertEquals(noProfileRes, false);
});
