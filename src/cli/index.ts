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

EXAMPLES:
  theorum test --profile studio
  theorum test --profile mermaid --lite
  theorum test --all --matrix
  theorum run --profile planner --prompt "Draft a product roadmap"
  theorum vault status
  theorum vault ping
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

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { _: [] };
  const positional = flags._;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (key === 'p' && i + 1 < args.length) {
        flags.profile = args[++i];
      } else if (key === 'a') {
        flags.all = true;
      } else if (key === 'h') {
        flags.help = true;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return flags;
}

export async function main(cliArgs = Deno.args): Promise<void> {
  const flags = parseFlags(cliArgs);
  const command = flags._[0] || (flags.help ? 'help' : 'help');

  switch (command) {
    case 'test': {
      const profile =
        typeof flags.profile === 'string'
          ? flags.profile
          : typeof flags.p === 'string'
            ? flags.p
            : undefined;
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
      break;
    }

    case 'run': {
      const profile =
        typeof flags.profile === 'string'
          ? flags.profile
          : typeof flags.p === 'string'
            ? flags.p
            : undefined;
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
      break;
    }

    case 'profile': {
      const sub = flags._[1] || 'list';
      if (sub === 'list') {
        listProfilesCommand();
      } else if (sub === 'show') {
        const id = flags._[2] || flags.profile;
        if (!id) {
          console.error('Error: Profile ID required (e.g. `theorum profile show studio`)');
          Deno.exit(1);
        }
        showProfileCommand(id);
      } else {
        showProfileCommand(sub);
      }
      break;
    }

    case 'vault': {
      const sub = flags._[1] || 'status';
      if (sub === 'status') {
        vaultStatusCommand();
      } else if (sub === 'ping') {
        await vaultPingCommand();
      } else {
        console.error(`Unknown vault command: '${sub}'. Use 'status' or 'ping'.`);
      }
      break;
    }
    default:
      printHelp();
      break;
  }
}

if (import.meta.main) {
  await main();
}
