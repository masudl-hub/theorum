/**
 * Host provider factory — the single public door for binding a profile to a transport.
 *
 * Routes from `profile.model.protocol` / `provider` (and whether the profile is
 * a speech role). Adapters under this folder are internal implementation.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import type { ModelProvider, Profile } from '../kernel/types.ts';
import type { GeminiTransport } from './keys.ts';
import { createOpenRouterProvider } from './openrouter.ts';
import type { OpenRouterConfig } from './openrouter-payload.ts';
import { createInteractionsProvider } from './provider.ts';
import { createSpeechProvider } from './speech.ts';

/** Credentials supplied by the host when creating a provider. */
export interface CreateProviderOptions {
  /** Google Interactions (chat, image, and speech when protocol is geminiInteractions). */
  gemini?: GeminiTransport;
  /**
   * OpenRouter-compatible credentials for `openAi` profiles.
   * Used for chat completions or `/audio/speech` when the profile is a speech role.
   * Optional `voice` is a fallback when `outputs.speech.voice` is omitted.
   */
  openRouter?: OpenRouterConfig & { voice?: string };
}

function isSpeechRole(profile: Profile): boolean {
  return profile.outputs.speech !== undefined;
}

/**
 * Create a `ModelProvider` for a profile.
 * One call: protocol/provider (and speech role) pick the transport.
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
    if (!options.openRouter) {
      throw new TheorumError('createProvider requires openRouter config for openAi/openrouter');
    }
    if (isSpeechRole(profile)) {
      return createSpeechProvider(options.openRouter);
    }
    return createOpenRouterProvider(options.openRouter);
  }

  throw new TheorumError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}
