import { listProfilesCommand, showProfileCommand } from './commands/profile.ts';
import { runCommand } from './commands/run.ts';
import { testProfileCommand } from './commands/test.ts';

function printHelp(): void {
  console.log(`
Theorum CLI - Profile Testing and Profile Inspection

USAGE:
  theorum <command> [options]

COMMANDS:
  test                 Run stress matrix or custom profile tests
    --profile, -p <id> Target profile ID registered by your host app
    --all, -a          Test all registered profiles
    --lite             Minimal fast-path connectivity ping
    --matrix           Run all valid permutations for the profile
    --mode <fast|smart> Reasoning mode override
    --search           Optional: set tool id googleSearch when allowlisted
    --map              Optional: set tool id googleMaps when allowlisted

  run                  Execute a turn with real-time streaming output
    --profile, -p <id> Target profile ID
    --prompt <text>    User prompt string
    --mode <fast|smart> Reasoning mode
    --search           Optional: set tool id googleSearch when allowlisted
    --map              Optional: set tool id googleMaps when allowlisted

  profile              Inspect registered profile blueprints
    list               List all registered profiles
    show <id>          Show detailed JSON profile specification

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
    console.error('Error: Profile ID required (e.g. `theorum run --profile your-profile`)');
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
    console.error('Error: Profile ID required (e.g. `theorum profile show your-profile`)');
    Deno.exit(1);
  }
  showProfileCommand(id);
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
  } else {
    printHelp();
  }
}

if (import.meta.main) {
  await main();
}
