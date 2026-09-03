#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-sys
/** Alias entry — see verify-guardrails-live.ts */
import { main } from './verify-guardrails-live.ts';

await main();
