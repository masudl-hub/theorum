/**
 * Provider adapters for THEORUM's `ModelProvider` contract.
 *
 * Use this entrypoint when a host app wants to bind THEORUM to Google
 * Interactions, OpenRouter-compatible chat completions, or speech synthesis.
 * Credentials are always supplied by the host application.
 *
 * @module
 */

export type { CreateProviderOptions } from './create-provider.ts';
export { createProvider } from './create-provider.ts';
export type { GeminiTransport, GeminiVault } from './keys.ts';
export {
  createOpenRouterProvider,
  resolveOpenRouterModel,
  toOpenRouterPayload,
} from './openrouter.ts';
export type { OpenRouterConfig } from './openrouter-payload.ts';
export { createInteractionsProvider } from './provider.ts';
export type { SpeechProviderConfig } from './speech.ts';
export { createSpeechProvider, streamSpeech, wrapPcmAsWav } from './speech.ts';
