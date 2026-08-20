#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

import type { ProviderCompleteRequest } from '../src/kernel/types.ts';
import { createOpenRouterProvider } from '../src/providers/openrouter.ts';

const apiKey = Deno.env.get('OPENROUTER_API_KEY');

if (!apiKey) {
  Deno.stdout.writeSync(
    new TextEncoder().encode(
      'Error: OPENROUTER_API_KEY environment variable is not set.\n' +
        'Pass --env-file=~/.config/theorum/.env or set OPENROUTER_API_KEY.\n',
    ),
  );
  Deno.exit(1);
}

Deno.stdout.writeSync(
  new TextEncoder().encode('Testing Theorum OpenRouter provider connection...\n'),
);

const provider = createOpenRouterProvider({
  apiKey,
  siteUrl: 'https://theorum.agent',
  siteName: 'Theorum Live Verification',
});

const req: ProviderCompleteRequest = {
  model: 'gemini35FlashLite',
  thinking: 'low',
  summaries: 'none',
  maxOutputTokens: 200,
  temperature: 0.2,
  system: 'You are a precise agent kernel verification assistant.',
  input: [
    {
      type: 'text',
      text: 'Verify live streaming: Return "Theorum + OpenRouter live stream verified successfully."',
    },
  ],
  builtins: [],
  structured: null,
  image: null,
  geminiBucket: 'planner',
};

try {
  let tokenCount = 0;

  for await (const event of provider.complete(req)) {
    if (event.type === 'thought' && event.text) {
      Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[33m${event.text}\x1b[0m`));
    } else if (event.type === 'text' && event.text) {
      Deno.stdout.writeSync(new TextEncoder().encode(event.text));
    } else if (event.type === 'tokens' && event.tokens) {
      tokenCount = event.tokens.total;
    } else if (event.type === 'error') {
      Deno.stderr.writeSync(
        new TextEncoder().encode(`\nReceived error event from provider: ${event.error}\n`),
      );
    }
  }

  Deno.stdout.writeSync(
    new TextEncoder().encode(`\n---\nLive test finished. Total tokens recorded: ${tokenCount}\n`),
  );
} catch (err) {
  Deno.stderr.writeSync(
    new TextEncoder().encode(`Live test failed with exception: ${String(err)}\n`),
  );
  Deno.exit(1);
}
