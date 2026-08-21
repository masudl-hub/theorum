import { registerBuiltinProfiles } from '../kernel/registry/builtin-profiles.ts';
import { listProfilesCommand, showProfileCommand } from './commands/profile.ts';
import { runCommand } from './commands/run.ts';
import { testProfileCommand } from './commands/test.ts';
import { vaultPingCommand, vaultStatusCommand } from './commands/vault.ts';

// Register built-in portfolio profiles
registerBuiltinProfiles();

// Auto-load .env if present
try {
  const envContent = await Deno.readTextFile('.env');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!Deno.env.get(key)) {
        Deno.env.set(key, val);
      }
    }
  }
} catch {
  // Ignore missing .env
}

function printHelp(): void {
  console.log(`
Theorum CLI - Profile Testing, REPL, and Vault Management

USAGE:
  theorum <command> [options]

COMMANDS:
  test                 Run stress matrix or custom profile tests
    --profile, -p <id> Target profile ID (e.g. studio, planner, mermaid)
    --all, -a          Test all registered profiles
    --lite             Minimal fast-path connectivity ping
    --matrix           Run all valid permutations for the profile
    --mode <fast|smart> Reasoning mode override
    --search           Force Google Search tool ON
    --map              Force Google Maps tool ON

  run                  Execute a turn with real-time streaming output
    --profile, -p <id> Target profile ID
    --prompt <text>    User prompt string
    --mode <fast|smart> Reasoning mode
    --search           Enable Google Search
    --map              Enable Google Maps

  profile              Inspect registered profile blueprints
    list               List all registered profiles
    show <id>          Show detailed JSON profile specification

  vault                Inspect and audit API credentials
    status             List key buckets and environment configuration
    ping               Probe live Gemini/OpenRouter endpoint connectivity

  help, --help, -h     Show this help message
`);
}

interface ParsedFlags {
  _: string[];
  profile?: string;
  p?: string;
  prompt?: string;
  mode?: string;
  all?: boolean;
  a?: boolean;
  lite?: boolean;
  matrix?: boolean;
  search?: boolean;
  map?: boolean;
  help?: boolean;
  [key: string]: unknown;
}

function parseLongFlag(arg: string, nextArg: string | undefined, flags: ParsedFlags): number {
  const key = arg.slice(2);
  if (nextArg && !nextArg.startsWith('-')) {
    flags[key] = nextArg;
    return 1;
  }
  flags[key] = true;
  return 0;
}

function parseShortFlag(arg: string, nextArg: string | undefined, flags: ParsedFlags): number {
  const key = arg.slice(1);
  if (key === 'p' && nextArg) {
    flags.profile = nextArg;
    return 1;
  }
  if (key === 'a') flags.all = true;
  else if (key === 'h') flags.help = true;
  else flags[key] = true;
  return 0;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { _: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg.startsWith('--')) {
      i += 1 + parseLongFlag(arg, next, flags);
    } else if (arg.startsWith('-')) {
      i += 1 + parseShortFlag(arg, next, flags);
    } else {
      flags._.push(arg);
      i += 1;
    }
  }
  return flags;
}

function extractProfileId(flags: ParsedFlags): string | undefined {
  if (typeof flags.profile === 'string') return flags.profile;
  if (typeof flags.p === 'string') return flags.p;
  return undefined;
}

async function handleTest(flags: ParsedFlags): Promise<void> {
  const profile = extractProfileId(flags);
  const success = await testProfileCommand(profile, {
    all: Boolean(flags.all || flags.a),
    lite: Boolean(flags.lite),
    matrix: Boolean(flags.matrix),
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
    search: flags.search ? true : undefined,
    map: flags.map ? true : undefined,
  });
  if (!success) {
    Deno.exit(1);
  }
}

async function handleRun(flags: ParsedFlags): Promise<void> {
  const profile = extractProfileId(flags);
  if (!profile) {
    console.error(
      'Error: Profile ID required (e.g. `theorum run --profile studio --prompt "Hello"`)',
    );
    Deno.exit(1);
  }
  const prompt = typeof flags.prompt === 'string' ? flags.prompt : flags._.slice(1).join(' ');
  await runCommand({
    profile,
    prompt,
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
    search: Boolean(flags.search),
    map: Boolean(flags.map),
  });
}

function handleProfile(flags: ParsedFlags): void {
  const sub = flags._[1] || 'list';
  if (sub === 'list') {
    listProfilesCommand();
    return;
  }
  const id = sub === 'show' ? flags._[2] || flags.profile : sub;
  if (typeof id !== 'string' || !id) {
    console.error('Error: Profile ID required (e.g. `theorum profile show studio`)');
    Deno.exit(1);
  }
  showProfileCommand(id);
}

async function handleVault(flags: ParsedFlags): Promise<void> {
  const sub = flags._[1] || 'status';
  if (sub === 'status') {
    vaultStatusCommand();
  } else if (sub === 'ping') {
    await vaultPingCommand();
  } else {
    console.error(`Unknown vault command: '${sub}'. Use 'status' or 'ping'.`);
  }
}

export async function main(cliArgs = Deno.args): Promise<void> {
  const flags = parseFlags(cliArgs);
  const command = flags._[0] || (flags.help ? 'help' : 'help');

  if (command === 'test') {
    await handleTest(flags);
  } else if (command === 'run') {
    await handleRun(flags);
  } else if (command === 'profile') {
    handleProfile(flags);
  } else if (command === 'vault') {
    await handleVault(flags);
  } else {
    printHelp();
  }
}

if (import.meta.main) {
  await main();
}
