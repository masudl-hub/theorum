import { vaultFromEnv } from '../../guardrails/keys.ts';
import { runTurn } from '../../kernel/engine/runner.ts';
import { getProfile, listProfiles } from '../../kernel/registry/profiles.ts';
import type { ModelProvider, Profile, TurnRequest } from '../../kernel/types.ts';
import { createOpenRouterProvider } from '../../providers/openrouter.ts';
import { createInteractionsProvider } from '../../providers/provider.ts';
import {
  buildCustomTurnRequest,
  type MatrixOptions,
  synthesizeMatrixCombos,
} from '../matrix/synthesizer.ts';

function createDefaultProvider(profile: Profile): ModelProvider {
  if (profile.model.protocol === 'openrouter' || profile.model.provider === 'openrouter') {
    return createOpenRouterProvider();
  }
  return createInteractionsProvider({ vault: vaultFromEnv() });
}

interface TestRunResult {
  passed: boolean;
  name: string;
  durationSec: number;
  tokensTotal?: number;
  error?: string;
}

export async function executeSingleTest(
  req: TurnRequest,
  testName: string,
  provider?: ModelProvider,
): Promise<TestRunResult> {
  const start = Date.now();
  const profile = getProfile(req.profile);
  const activeProvider = provider ?? createDefaultProvider(profile);

  console.log(`\n▶ [THEORUM TEST] ${testName}`);
  console.log(`  Profile:     ${req.profile} (Mode: ${req.select ?? 'default'})`);
  console.log(
    `  Tools:       ${
      Object.entries(req.tools ?? {})
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k)
        .join(', ') || 'none'
    }`,
  );
  console.log(
    `  Attachments: ${req.input.attachments?.length ?? 0} file(s) | Voice: ${req.input.voice?.length ? 'yes' : 'no'}`,
  );
  console.log(`  ${'-'.repeat(60)}`);

  let totalTokens = 0;
  let hasError = false;
  let errorMessage = '';
  let _textOutput = '';
  let _sawStructured = false;

  try {
    for await (const event of runTurn(req, activeProvider)) {
      if (event.type === 'thought' && event.text) {
        // Thinking chunk
        Deno.stdout.write(new TextEncoder().encode('.'));
      } else if (event.type === 'tool' && event.tool) {
        console.log(
          `\n  ⚡ [Tool Dispatched] ${event.tool.name}(${JSON.stringify(event.tool.arguments ?? {})})`,
        );
      } else if (event.type === 'text' && event.text) {
        _textOutput += event.text;
      } else if (event.type === 'structured') {
        _sawStructured = true;
        console.log(`\n  ✓ [Structured Schema Validated]`);
      } else if (event.type === 'media') {
        console.log(`\n  ✓ [Media Generated] (${event.media?.mimeType})`);
      } else if (event.type === 'tokens' && event.tokens) {
        totalTokens = event.tokens.total;
      } else if (event.type === 'error' && event.error) {
        hasError = true;
        errorMessage = event.error;
      }
    }
  } catch (err) {
    hasError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const durationSec = (Date.now() - start) / 1000;
  const passed = !hasError;

  if (passed) {
    console.log(
      `\n  ✓ STATUS: PASSED (took ${durationSec.toFixed(2)}s, ${totalTokens ? `${totalTokens} tokens` : 'ok'})`,
    );
  } else {
    console.log(`\n  ✗ STATUS: FAILED: ${errorMessage} (${durationSec.toFixed(2)}s)`);
  }

  return {
    passed,
    name: testName,
    durationSec,
    tokensTotal: totalTokens,
    error: errorMessage,
  };
}

export async function testProfileCommand(
  profileId?: string,
  options: MatrixOptions & { all?: boolean; matrix?: boolean } = {},
): Promise<boolean> {
  const results: TestRunResult[] = [];

  const targetProfiles: Profile[] = [];
  if (options.all) {
    targetProfiles.push(...listProfiles());
  } else if (profileId) {
    try {
      targetProfiles.push(getProfile(profileId));
    } catch (err) {
      console.error(`\n Error: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  } else {
    console.error(
      'Error: Please specify a profile ID (e.g. `theorum test --profile studio`) or `--all`.',
    );
    return false;
  }

  if (targetProfiles.length === 0) {
    console.log('\n No profiles to test.\n');
    return false;
  }

  for (const profile of targetProfiles) {
    if (options.matrix) {
      const combos = synthesizeMatrixCombos(profile);
      for (const combo of combos) {
        const res = await executeSingleTest(combo.req, `${profile.id} [${combo.name}]`);
        results.push(res);
      }
    } else {
      const req = buildCustomTurnRequest(profile, options);
      const testName = options.lite ? `${profile.id} [Lite]` : `${profile.id} [Stress Combo]`;
      const res = await executeSingleTest(req, testName);
      results.push(res);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(' TEST SUMMARY:');
  console.log('='.repeat(70));
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? '✓ PASSED' : '✗ FAILED';
    console.log(`  ${status.padEnd(10)} ${r.name.padEnd(45)} (${r.durationSec.toFixed(2)}s)`);
    if (!r.passed) {
      allPassed = false;
      if (r.error) console.log(`             Reason: ${r.error}`);
    }
  }
  console.log(`${'='.repeat(70)}\n`);
  return allPassed;
}
