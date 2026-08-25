/**
 * OpenRouter provider adapter and payload helpers.
 *
 * Prefer `createProvider(profile, { openRouter })` from `theorum` / `theorum/providers`
 * for turn execution. This entrypoint is for hosts that build OpenRouter payloads
 * outside the runner.
 *
 * @module
 */

export { createOpenRouterProvider } from './openrouter.ts';
export type { OpenRouterConfig } from './openrouter-payload.ts';
export {
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from './openrouter-payload.ts';
