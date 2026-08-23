/**
 * Provider adapters for THEORUM's `ModelProvider` contract.
 *
 * Use this entrypoint when a host app wants to bind THEORUM to Google
 * Interactions, OpenRouter-compatible chat completions, or OpenRouter TTS.
 * Credentials are always supplied by the host application.
 *
 * @module
 */

export type { OpenRouterConfig } from './openrouter.ts';
export {
  createOpenRouterProvider,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from './openrouter.ts';
export { createInteractionsProvider } from './provider.ts';
export type { OpenRouterTtsConfig } from './tts.ts';
export {
  createOpenRouterTtsProvider,
  streamOpenRouterTts,
  wrapPcmAsWav,
} from './tts.ts';
