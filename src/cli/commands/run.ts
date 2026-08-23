import { runTurn } from '../../kernel/engine/runner.ts';
import { getProfile } from '../../kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent, TurnRequest } from '../../kernel/types.ts';

export interface RunOptions {
  profile: string;
  prompt?: string;
  mode?: string;
  search?: boolean;
  map?: boolean;
  provider?: ModelProvider;
}

function handleRunEvent(event: TurnEvent): void {
  if (event.type === 'thought' && event.text) {
    Deno.stdout.write(new TextEncoder().encode(`\x1b[2m${event.text}\x1b[0m`));
  } else if (event.type === 'text' && event.text) {
    Deno.stdout.write(new TextEncoder().encode(event.text));
  } else if (event.type === 'tool' && event.tool) {
    console.log(`\n\x1b[33m⚡ [Tool Call] ${event.tool.name}\x1b[0m:`, event.tool.arguments);
  } else if (event.type === 'structured' && event.structured) {
    console.log('\n\x1b[32m✓ [Structured Output]\x1b[0m:');
    console.log(JSON.stringify(event.structured, null, 2));
  } else if (event.type === 'media' && event.media) {
    console.log(`\n\x1b[34m🖼 [Media Output]\x1b[0m (${event.media.mimeType})`);
  } else if (event.type === 'error' && event.error) {
    console.error(`\n\x1b[31m✗ Error\x1b[0m: ${event.error}`);
  }
}

export async function runCommand(options: RunOptions): Promise<void> {
  getProfile(options.profile);
  const provider = options.provider;
  if (!provider) {
    console.error(
      '\n\x1b[31mExecution Failed\x1b[0m: Theorum CLI does not create providers or read keys. Run turns from a host app with an explicit ModelProvider.\n',
    );
    return;
  }

  const prompt = options.prompt || 'Hello! Please introduce your capabilities.';
  const tools: Record<string, boolean> = {};
  if (options.search) tools.googleSearch = true;
  if (options.map) tools.googleMaps = true;

  const req: TurnRequest = {
    profile: options.profile,
    select: options.mode,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    input: { text: prompt },
  };

  console.log(`\n▶ [RUNNING TURN] Profile: ${options.profile} (${options.mode ?? 'default'})`);
  console.log(`Prompt: "${prompt}"\n`);

  try {
    for await (const event of runTurn(req, provider)) {
      handleRunEvent(event);
    }
    console.log('\n');
  } catch (err) {
    console.error(
      `\n\x1b[31mExecution Failed\x1b[0m: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
