/**
 * Host provider factory: route by profile `protocol` / `provider`.
 *
 * - `geminiInteractions` + `google` → Interactions (chat, image, and speech)
 * - `openAi` + `openrouter` + speech role → `/audio/speech`
 * - `openAi` + `openrouter` → chat completions
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import type { ModelProvider, Profile } from '../kernel/types.ts';
import type { GeminiTransport } from './keys.ts';
import { createOpenRouterProvider } from './openrouter.ts';
import type { OpenRouterConfig } from './openrouter-payload.ts';
import { createInteractionsProvider } from './provider.ts';
import { createSpeechProvider, type SpeechProviderConfig } from './speech.ts';

/** Credentials and transports supplied by the host when creating a provider. */
export interface CreateProviderOptions {
  gemini?: GeminiTransport;
  openRouter?: OpenRouterConfig;
  /** OpenRouter-compatible `/audio/speech` config (speech-role + openAi). */
  speech?: SpeechProviderConfig;
}

function isSpeechRole(profile: Profile): boolean {
  return profile.outputs.speech !== undefined;
}

/**
 * Create a `ModelProvider` for a profile's protocol/provider.
 * Speech on Google uses Interactions; speech on OpenRouter uses `/audio/speech`.
 */
export function createProvider(
  profile: Profile,
  options: CreateProviderOptions = {},
): ModelProvider {
  const { protocol, provider } = profile.model;

  if (protocol === 'geminiInteractions' && provider === 'google') {
    if (!options.gemini) {
      throw new TheorumError('createProvider requires gemini transport for google Interactions');
    }
    return createInteractionsProvider(options.gemini);
  }

  if (protocol === 'openAi' && provider === 'openrouter') {
    if (isSpeechRole(profile)) {
      return createSpeechProvider(options.speech ?? options.openRouter ?? {});
    }
    if (!options.openRouter) {
      throw new TheorumError('createProvider requires openRouter config for openAi/openrouter');
    }
    return createOpenRouterProvider(options.openRouter);
  }

  throw new TheorumError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}
