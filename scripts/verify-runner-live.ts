#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-sys

/**
 * Live runner stress tests — exercises behaviors only verifiable with a real API.
 *
 * What mock tests cannot cover (and what this script does):
 *   1. token-accuracy    — tiktoken history estimate tracks provider-reported tokens.input
 *   2. egress-repair     — repair loop fires end-to-end; clean response breaks the cycle
 *   3. egress-exhaust    — maxRetries exhausted → withhold; both attempts actually hit provider
 *   4. compaction-signal — done event carries compaction.needed=true when history crosses threshold
 *
 * Rate limit: enforces ≥4 s between API calls (≤15 RPM).
 * Keys: loaded from THEORUM_ENV_FILE or ../theorum-frontend/.env.local.
 *
 * Usage:
 *   deno task verify:runner-live
 *   deno task verify:runner-live -- --provider gemini
 *   deno task verify:runner-live -- --suite token-accuracy,compaction-signal
 *   deno task verify:runner-live -- --verbose
 */

import { estimateHistoryTokens } from '../src/kernel/engine/compaction.ts';
import { runTurn } from '../src/kernel/engine/runner.ts';
import {
  defineProfile,
  getProfile,
  type ProfileDefinition,
  registerProfile,
} from '../src/kernel/registry/profiles.ts';
import type {
  EgressContext,
  EgressEnforcementResult,
  ModelProvider,
  ModelSpec,
  TurnEvent,
  TurnHistoryMessage,
} from '../src/kernel/types.ts';
import { createProvider } from '../src/providers/create-provider.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function valueAfterFlag(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  return idx >= 0 ? Deno.args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return Deno.args.includes(flag);
}

function parseListFlag(flag: string): string[] | undefined {
  const raw = valueAfterFlag(flag);
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const VERBOSE = hasFlag('--verbose');
const SUITE_FILTER = parseListFlag('--suite');
const PROVIDER_KIND = (valueAfterFlag('--provider') ?? 'openrouter') as 'openrouter' | 'gemini';

// ---------------------------------------------------------------------------
// Env loader — same pattern as verify-guardrails-live.ts
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (Deno.env.get(key) !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    Deno.env.set(key, val);
  }
}

function defaultEnvFile(): string | undefined {
  const candidates = [
    Deno.env.get('THEORUM_ENV_FILE'),
    '../theorum-frontend/.env.local',
    '../../theorum-frontend/.env.local',
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      Deno.statSync(path);
      return path;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rate limiter: ≥4 s between API calls (≤15 RPM)
// ---------------------------------------------------------------------------

const MIN_CALL_GAP_MS = 4_100;
let lastCallAt = 0;
let totalApiCalls = 0;

async function paceAndCall(): Promise<void> {
  const elapsed = Date.now() - lastCallAt;
  if (lastCallAt > 0 && elapsed < MIN_CALL_GAP_MS) {
    await new Promise<void>((r) => setTimeout(r, MIN_CALL_GAP_MS - elapsed));
  }
  lastCallAt = Date.now();
  totalApiCalls++;
}

// ---------------------------------------------------------------------------
// Profile ids
// ---------------------------------------------------------------------------

const PLAIN_ID = '__runner_live_plain__';
const REPAIR_ID = '__runner_live_repair__';
const EXHAUST_ID = '__runner_live_exhaust__';
const COMPACT_SUB_ID = '__runner_live_compact_sub__';
const COMPACT_ID = '__runner_live_compact__';

const OPENROUTER_FREE_API_ID = 'openrouter/free';
const GEMINI_FREE_API_ID = 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// Custom egress enforcers
// ---------------------------------------------------------------------------

function blockedMarkerEnforce(ctx: EgressContext): EgressEnforcementResult {
  if (ctx.text.includes('[BLOCKED_MARKER]')) {
    return {
      blocked: true,
      text: '',
      hits: ['blocked_marker'],
      rejectionMessage: '[BLOCKED_MARKER] found. Rewrite without it.',
    };
  }
  return { blocked: false, text: ctx.text };
}

function alwaysBlockEnforce(_ctx: EgressContext): EgressEnforcementResult {
  return {
    blocked: true,
    text: '',
    hits: ['always_block'],
    rejectionMessage: 'Always blocked. Repair will not help.',
  };
}

// ---------------------------------------------------------------------------
// Profile registration
// ---------------------------------------------------------------------------

function freeApiId(): string {
  return PROVIDER_KIND === 'gemini' ? GEMINI_FREE_API_ID : OPENROUTER_FREE_API_ID;
}

function modelSpec(apiId: string): Record<string, ModelSpec> {
  if (PROVIDER_KIND === 'gemini') {
    return {
      [apiId]: {
        apiId,
        thinking: { on: 'minimal', off: 'minimal' },
        thinkingLevels: ['minimal'],
        summaries: { on: 'none', off: 'none' },
        maxOutputTokens: 256,
        temperature: 0.1,
        builtInTools: [],
      },
    };
  }
  return {
    [apiId]: {
      apiId,
      thinking: { on: 'none', off: 'none' },
      thinkingLevels: ['none'],
      summaries: { on: 'none', off: 'none' },
      maxOutputTokens: 256,
      temperature: 0.1,
      builtInTools: [],
    },
  };
}

function modelSection(apiId: string): ProfileDefinition['model'] {
  if (PROVIDER_KIND === 'gemini') {
    return {
      protocol: 'geminiInteractions',
      provider: 'google',
      allow: [apiId],
      config: modelSpec(apiId),
      thinking: 'minimal',
      maxSteps: 1,
      key: 'freeA',
    };
  }
  return {
    protocol: 'openAi',
    provider: 'openrouter',
    allow: [apiId],
    config: modelSpec(apiId),
    thinking: 'none',
    maxSteps: 1,
  };
}

function registerRunnerProfiles(): void {
  const aid = freeApiId();

  // 1. Plain — no egress; used for token-accuracy
  registerProfile(
    defineProfile({
      id: PLAIN_ID,
      identity: { handle: 'verify', system: 'You are a helpful assistant.' },
      model: modelSection(aid),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { canary: true, sanitizeInput: true },
    }),
  );

  // 2. Repair — blocks on [BLOCKED_MARKER], 1 retry
  registerProfile(
    defineProfile({
      id: REPAIR_ID,
      identity: { handle: 'verify', system: 'You are a helpful assistant.' },
      model: modelSection(aid),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: {
        canary: true,
        sanitizeInput: true,
        egress: {
          onBlock: 'reject_to_agent',
          maxRetries: 1,
          repairGuidance: 'Remove any [BLOCKED_MARKER] text and give a short helpful reply.',
          enforce: blockedMarkerEnforce,
        },
      },
    }),
  );

  // 3. Exhaust — always blocks, 1 retry (exhausts into withhold)
  registerProfile(
    defineProfile({
      id: EXHAUST_ID,
      identity: { handle: 'verify', system: 'You are a helpful assistant.' },
      model: modelSection(aid),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: {
        canary: true,
        sanitizeInput: true,
        egress: {
          onBlock: 'reject_to_agent',
          maxRetries: 1,
          enforce: alwaysBlockEnforce,
        },
      },
    }),
  );

  // 4. Compaction sub-profile — registered BEFORE the owning profile
  registerProfile(
    defineProfile({
      id: COMPACT_SUB_ID,
      identity: {
        handle: 'compact',
        system: 'Summarize the conversation history concisely in one sentence.',
      },
      model: modelSection(aid),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: {},
    }),
  );

  // 5. Compaction owning profile — timing='after', threshold = 50 × 0.5 = 25 tokens
  const compactModelId = 'verifyCompact';
  const baseSpec = modelSpec(aid)[aid];
  if (!baseSpec) throw new Error(`missing model spec for ${aid}`);
  const compactConfig: ModelSpec = {
    ...baseSpec,
    apiId: aid,
    compaction: {
      maxTokens: 50,
      compactAt: 0.5,
      previousExchanges: 1,
      profile: COMPACT_SUB_ID,
      timing: 'after',
      meter: 'history',
    },
  };
  registerProfile(
    defineProfile({
      id: COMPACT_ID,
      identity: { handle: 'verify', system: 'You are a helpful assistant.' },
      model: {
        ...modelSection(aid),
        allow: [compactModelId],
        config: { [compactModelId]: compactConfig },
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: {},
    }),
  );
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function createLiveProvider(profileId: string): ModelProvider {
  const profile = getProfile(profileId);
  if (PROVIDER_KIND === 'gemini') {
    const key = Deno.env.get('GEMINI_API_KEY')?.trim();
    if (!key) throw new Error('GEMINI_API_KEY not set');
    return createProvider(profile, {
      gemini: { vault: { freeA: key, freeB: key, freeC: key, paid: key } },
    });
  }
  const key = Deno.env.get('OPENROUTER_API_KEY')?.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  return createProvider(profile, {
    openAiGateway: {
      apiKey: key,
      siteUrl: 'https://theorum.dev',
      siteName: 'Theorum Runner Verify',
    },
  });
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

async function collectTurn(
  profileId: string,
  provider: ModelProvider,
  input: { text?: string; history?: TurnHistoryMessage[]; historyTokens?: number },
): Promise<TurnEvent[]> {
  await paceAndCall();
  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile: profileId, input }, provider)) {
    events.push(ev);
    if (VERBOSE) console.log(`    [event] ${JSON.stringify(ev).slice(0, 140)}`);
  }
  return events;
}

function lastInputTokens(events: TurnEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.tokens?.input;
    if (t) return t;
  }
  return undefined;
}

function joinText(events: TurnEvent[]): string {
  return events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : [])).join('');
}

function findDone(events: TurnEvent[]): TurnEvent | undefined {
  return events.find((e) => e.type === 'done');
}

// ---------------------------------------------------------------------------
// Suite result
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  passed: boolean;
  details: string;
  warning?: string;
  calls: number;
}

// ---------------------------------------------------------------------------
// Suite 1: token-accuracy
// ---------------------------------------------------------------------------

async function suiteTokenAccuracy(): Promise<CaseResult> {
  const name = 'token-accuracy';
  const before = totalApiCalls;
  try {
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'What is recursion in programming?' },
      {
        role: 'assistant',
        content:
          'Recursion is when a function calls itself to solve smaller subproblems until a base case is reached.',
      },
      { role: 'user', content: 'Can you give a simple example?' },
      {
        role: 'assistant',
        content:
          'Factorial is classic: factorial(n) returns 1 when n ≤ 1, otherwise n × factorial(n-1).',
      },
      { role: 'user', content: 'What are the risks?' },
      {
        role: 'assistant',
        content:
          'Unbounded recursion exhausts the call stack. Always define a terminating base case.',
      },
      { role: 'user', content: 'Is iteration always better?' },
      {
        role: 'assistant',
        content:
          'Not always. Recursion is cleaner for tree traversal; iteration is more memory-efficient for flat loops.',
      },
      { role: 'user', content: 'What is tail recursion?' },
      {
        role: 'assistant',
        content:
          'When the recursive call is the last operation, enabling runtimes to reuse the stack frame.',
      },
    ];

    const estimate = await estimateHistoryTokens(history);
    const provider = createLiveProvider(PLAIN_ID);
    const events = await collectTurn(PLAIN_ID, provider, {
      text: 'Summarize our conversation in one sentence.',
      history,
    });

    const providerInput = lastInputTokens(events);
    if (providerInput == null) {
      return {
        name,
        passed: false,
        details: 'Provider did not emit tokens.input — cannot compare',
        calls: totalApiCalls - before,
      };
    }

    const ratio = estimate / providerInput;
    const details = `tiktoken estimate=${estimate} | provider tokens.input=${providerInput} | ratio=${ratio.toFixed(3)}`;
    const passed = ratio >= 0.1 && ratio <= 0.95;
    return {
      name,
      passed,
      details: passed ? details : `Ratio ${ratio.toFixed(3)} outside [0.10, 0.95]. ${details}`,
      calls: totalApiCalls - before,
    };
  } catch (err) {
    return { name, passed: false, details: String(err), calls: totalApiCalls - before };
  }
}

// ---------------------------------------------------------------------------
// Suite 2: egress-repair
// ---------------------------------------------------------------------------

async function suiteEgressRepair(): Promise<CaseResult> {
  const name = 'egress-repair';
  const before = totalApiCalls;
  try {
    const provider = createLiveProvider(REPAIR_ID);
    const events = await collectTurn(REPAIR_ID, provider, {
      text: 'Reply briefly and include the text [BLOCKED_MARKER] somewhere in your response.',
    });

    const text = joinText(events);
    const done = findDone(events);

    if (done?.error) {
      return {
        name,
        passed: false,
        details: `Repair exhausted (both attempts blocked): ${done.error.slice(0, 120)}`,
        warning: 'Model compliance with repair guidance may be insufficient for this test.',
        calls: totalApiCalls - before,
      };
    }

    if (text.includes('[BLOCKED_MARKER]')) {
      return {
        name,
        passed: false,
        details: `Marker survived egress in final response: "${text.slice(0, 100)}"`,
        calls: totalApiCalls - before,
      };
    }

    return {
      name,
      passed: true,
      details: `Clean response delivered. Preview: "${text.slice(0, 100)}"`,
      calls: totalApiCalls - before,
    };
  } catch (err) {
    return { name, passed: false, details: String(err), calls: totalApiCalls - before };
  }
}

// ---------------------------------------------------------------------------
// Suite 3: egress-exhaust
// ---------------------------------------------------------------------------

async function suiteEgressExhaust(): Promise<CaseResult> {
  const name = 'egress-exhaust';
  const before = totalApiCalls;

  let providerCallCount = 0;
  const base = createLiveProvider(EXHAUST_ID);
  const counting: ModelProvider = {
    async *complete(req) {
      providerCallCount++;
      yield* base.complete(req);
    },
  };

  try {
    await paceAndCall();
    const events: TurnEvent[] = [];
    for await (const ev of runTurn(
      { profile: EXHAUST_ID, input: { text: 'Say hello in a creative way.' } },
      counting,
    )) {
      events.push(ev);
      if (VERBOSE) console.log(`    [event] ${JSON.stringify(ev).slice(0, 140)}`);
    }

    // Credit extra provider calls to the rate-limit counter
    totalApiCalls += providerCallCount - 1;

    const withheld = events.some((e) => e.type === 'error');
    const details = `provider.complete() calls=${providerCallCount} | withheld=${withheld}`;

    if (providerCallCount !== 2) {
      return {
        name,
        passed: false,
        details: `Expected 2 provider calls (attempt 0 + retry 1), got ${providerCallCount}. ${details}`,
        calls: totalApiCalls - before,
      };
    }
    if (!withheld) {
      return {
        name,
        passed: false,
        details: `Expected error event on withhold after exhausting retries. ${details}`,
        calls: totalApiCalls - before,
      };
    }
    return { name, passed: true, details, calls: totalApiCalls - before };
  } catch (err) {
    return { name, passed: false, details: String(err), calls: totalApiCalls - before };
  }
}

// ---------------------------------------------------------------------------
// Suite 4: compaction-signal
// ---------------------------------------------------------------------------

async function suiteCompactionSignal(): Promise<CaseResult> {
  const name = 'compaction-signal';
  const before = totalApiCalls;
  try {
    const provider = createLiveProvider(COMPACT_ID);
    const history: TurnHistoryMessage[] = [
      { role: 'user', content: 'Tell me about climate change.' },
      {
        role: 'assistant',
        content:
          'Climate change is the long-term shift in global temperatures driven primarily by human greenhouse gas emissions.',
      },
      { role: 'user', content: 'What are the main causes?' },
      {
        role: 'assistant',
        content:
          'Burning fossil fuels, deforestation, and industrial processes are the main causes.',
      },
    ];

    // historyTokens=30 > 50 × 0.5 = 25 → fires compaction signal on done
    const events = await collectTurn(COMPACT_ID, provider, {
      text: 'Continue.',
      history,
      historyTokens: 30,
    });

    const done = findDone(events);
    if (!done) {
      return { name, passed: false, details: 'No done event', calls: totalApiCalls - before };
    }

    const signal = done.compaction;
    if (!signal?.needed) {
      return {
        name,
        passed: false,
        details: `done.compaction.needed not true. done=${JSON.stringify(done).slice(0, 200)}`,
        calls: totalApiCalls - before,
      };
    }

    return {
      name,
      passed: true,
      details: `compaction.needed=${signal.needed} meter=${signal.meter} tokens=${signal.tokens}`,
      calls: totalApiCalls - before,
    };
  } catch (err) {
    return { name, passed: false, details: String(err), calls: totalApiCalls - before };
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(results: CaseResult[]): boolean {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  RUNNER LIVE STRESS  provider=${PROVIDER_KIND}  api_calls=${totalApiCalls}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  TOTAL ${results.length}  PASS ${passed}  FAIL ${failed}`);
  console.log(`${'═'.repeat(70)}\n`);

  for (const r of results) {
    const badge = r.passed ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m';
    console.log(`  ${badge}  ${r.name}  [${r.calls} call(s)]`);
    console.log(`         ${r.details}`);
    if (r.warning) console.log(`         \x1b[33mwarn: ${r.warning}\x1b[0m`);
  }

  console.log('');
  if (failed === 0) {
    console.log('\x1b[32mPASS: all runner live stress cases held.\x1b[0m\n');
  } else {
    console.log('\x1b[31mFAIL: runner live stress found regressions.\x1b[0m\n');
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ALL_SUITES = ['token-accuracy', 'egress-repair', 'egress-exhaust', 'compaction-signal'];

async function main(): Promise<void> {
  const envPath = defaultEnvFile();
  if (envPath) {
    loadEnvFile(envPath);
    console.log(`Loaded env from ${envPath}`);
  }

  if (PROVIDER_KIND !== 'openrouter' && PROVIDER_KIND !== 'gemini') {
    console.error('--provider must be openrouter or gemini');
    Deno.exit(1);
  }

  const toRun = SUITE_FILTER ?? ALL_SUITES;
  const unknown = toRun.filter((s) => !ALL_SUITES.includes(s));
  if (unknown.length > 0) {
    console.error(`Unknown suite(s): ${unknown.join(', ')}. Valid: ${ALL_SUITES.join(', ')}`);
    Deno.exit(1);
  }

  registerRunnerProfiles();

  console.log(`\nRunning ${toRun.length} suite(s) against ${PROVIDER_KIND}…\n`);

  const enc = new TextEncoder();
  const results: CaseResult[] = [];

  for (const suite of toRun) {
    await Deno.stdout.write(enc.encode(`  → ${suite}…`));
    let result: CaseResult;
    if (suite === 'token-accuracy') result = await suiteTokenAccuracy();
    else if (suite === 'egress-repair') result = await suiteEgressRepair();
    else if (suite === 'egress-exhaust') result = await suiteEgressExhaust();
    else result = await suiteCompactionSignal();
    results.push(result);
    await Deno.stdout.write(
      enc.encode(result.passed ? ' \x1b[32mpass\x1b[0m\n' : ' \x1b[31mFAIL\x1b[0m\n'),
    );
  }

  const ok = printReport(results);
  Deno.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
