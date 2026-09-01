import { runTurn } from '../../kernel/engine/runner.ts';
import { getProfile, listProfiles } from '../../kernel/registry/profiles.ts';
import type { ModelProvider, Profile, TurnEvent, TurnRequest } from '../../kernel/types.ts';
import {
  buildCustomTurnRequest,
  type MatrixOptions,
  synthesizeMatrixCombos,
} from '../matrix/synthesizer.ts';

export interface TestRunResult {
  passed: boolean;
  name: string;
  durationSec: number;
  tokensTotal?: number;
  error?: string;
}

interface TestExecutionAccumulator {
  totalTokens: number;
  hasError: boolean;
  errorMessage: string;
}

function printTestHeader(req: TurnRequest, testName: string): void {
  const activeTools = Object.entries(req.tools ?? {})
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
    .join(', ');

  console.log(`\n▶ [THEORUM TEST] ${testName}`);
  console.log(`  Profile:     ${req.profile} (Mode: ${req.select ?? 'default'})`);
  console.log(`  Tools:       ${activeTools || 'none'}`);
  console.log(
    `  Attachments: ${req.input?.attachments?.length ?? 0} file(s) | Voice: ${req.input?.voice?.length ? 'yes' : 'no'}`,
  );
  console.log(`  ${'-'.repeat(60)}`);
}

function processTestEvent(event: TurnEvent, acc: TestExecutionAccumulator): void {
  if (event.type === 'thought' && event.text) {
    Deno.stdout.write(new TextEncoder().encode('.'));
  } else if (event.type === 'tool' && event.tool) {
    console.log(
      `\n  ⚡ [Tool Dispatched] ${event.tool.name}(${JSON.stringify(event.tool.arguments ?? {})})`,
    );
  } else if (event.type === 'evidence' && event.evidence) {
    const e = event.evidence;
    if (e.kind === 'code_execution_call') {
      const preview = (e.code ?? '').replaceAll('\n', ' ').slice(0, 80);
      console.log(`\n  🐍 [code_execution_call] ${preview || e.id || ''}`);
    } else if (e.kind === 'code_execution_result') {
      const preview = (e.result ?? '').replaceAll('\n', ' ').slice(0, 80);
      console.log(`\n  🐍 [code_execution_result] isError=${String(e.isError)} ${preview}`);
    } else if (e.kind) {
      console.log(`\n  📎 [evidence] ${e.kind}`);
    }
  } else if (event.type === 'structured') {
    console.log(`\n  ✓ [Structured Schema Validated]`);
  } else if (event.type === 'media') {
    console.log(`\n  ✓ [Media Generated] (${event.media?.mimeType})`);
  } else if (event.type === 'tokens' && event.tokens) {
    acc.totalTokens = event.tokens.total;
  } else if (event.type === 'error' && event.error) {
    acc.hasError = true;
    acc.errorMessage = event.error;
    console.error(`\n  [Test Error Detail]: ${event.error}`);
  }
}

function printTestResult(
  passed: boolean,
  durationSec: number,
  acc: TestExecutionAccumulator,
): void {
  if (passed) {
    console.log(
      `\n  ✓ STATUS: PASSED (took ${durationSec.toFixed(2)}s, ${acc.totalTokens ? `${acc.totalTokens} tokens` : 'ok'})`,
    );
  } else {
    console.log(`\n  ✗ STATUS: FAILED: ${acc.errorMessage} (${durationSec.toFixed(2)}s)`);
  }
}

export async function executeSingleTest(
  req: TurnRequest,
  testName: string,
  provider?: ModelProvider,
): Promise<TestRunResult> {
  const start = Date.now();
  getProfile(req.profile);
  printTestHeader(req, testName);

  const acc: TestExecutionAccumulator = {
    totalTokens: 0,
    hasError: false,
    errorMessage: '',
  };

  try {
    if (!provider) {
      throw new Error(
        'Theorum CLI does not create providers or read keys. Pass an explicit ModelProvider from the host app.',
      );
    }
    for await (const event of runTurn(req, provider)) {
      processTestEvent(event, acc);
    }
  } catch (err) {
    acc.hasError = true;
    acc.errorMessage = err instanceof Error ? err.message : String(err);
  }

  const durationSec = (Date.now() - start) / 1000;
  const passed = !acc.hasError;
  printTestResult(passed, durationSec, acc);

  return {
    passed,
    name: testName,
    durationSec,
    tokensTotal: acc.totalTokens,
    error: acc.errorMessage,
  };
}

function resolveTargetProfiles(
  profileId: string | undefined,
  all: boolean | undefined,
): Profile[] | null {
  if (all) {
    return listProfiles();
  }
  if (profileId) {
    try {
      return [getProfile(profileId)];
    } catch (err) {
      console.error(`\n Error: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }
  console.error(
    'Error: Please specify a profile ID (e.g. `theorum test --profile your-profile`) or `--all`.',
  );
  return null;
}

async function runProfileMatrix(
  profile: Profile,
  provider?: ModelProvider,
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  const combos = synthesizeMatrixCombos(profile);
  for (const combo of combos) {
    const res = await executeSingleTest(combo.req, `${profile.id} [${combo.name}]`, provider);
    results.push(res);
  }
  return results;
}

async function runProfileSingle(
  profile: Profile,
  options: MatrixOptions,
  provider?: ModelProvider,
): Promise<TestRunResult> {
  const req = buildCustomTurnRequest(profile, options);
  const testName = options.lite ? `${profile.id} [Lite]` : `${profile.id} [Stress Combo]`;
  return await executeSingleTest(req, testName, provider);
}

function printSummaryReport(results: TestRunResult[]): boolean {
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

export async function testProfileCommand(
  profileId?: string,
  options: MatrixOptions & { all?: boolean; matrix?: boolean; provider?: ModelProvider } = {},
): Promise<boolean> {
  const targetProfiles = resolveTargetProfiles(profileId, options.all);
  if (!targetProfiles || targetProfiles.length === 0) {
    return false;
  }

  const results: TestRunResult[] = [];
  for (const profile of targetProfiles) {
    if (options.matrix) {
      results.push(...(await runProfileMatrix(profile, options.provider)));
    } else {
      results.push(await runProfileSingle(profile, options, options.provider));
    }
  }

  return printSummaryReport(results);
}
