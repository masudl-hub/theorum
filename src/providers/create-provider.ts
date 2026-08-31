/**
 * Host provider factory — the single public door for binding a profile to a transport.
 *
 * Routes from `profile.model.protocol` / `provider` (and whether the profile is
 * a speech role). Adapters under this folder are internal implementation.
 *
 * The OpenRouter / Vercel AI SDK stack is loaded only when an `openAi` +
 * `openrouter` chat provider actually runs `complete` — not when this module
 * is imported, and not for Google or local paths.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import type {
  ModelProvider,
  Profile,
  ProviderCompleteRequest,
  TurnEvent,
} from '../kernel/types.ts';
import { exposeForTests } from './expose-for-tests.ts';
import type { GeminiTransport } from './keys.ts';
import { createLocalProvider, type LocalProviderConfig } from './local.ts';
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
  /** Local OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio). */
  local?: LocalProviderConfig;
}

function isSpeechRole(profile: Profile): boolean {
  return profile.outputs.speech !== undefined;
}

/**
 * Defer loading `@openrouter/ai-sdk-provider` / `ai` until the first `complete`.
 * Keeps Google and local hosts free of the Vercel SDK graph.
 */
function lazyOpenRouterChat(config: OpenRouterConfig): ModelProvider {
  let pending: Promise<ModelProvider> | undefined;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      pending ??= import('./openrouter.ts').then((m) => m.createOpenRouterProvider(config));
      yield* (await pending).complete(req);
    },
  };
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
    return lazyOpenRouterChat(options.openRouter);
  }

  if (protocol === 'openAi' && provider === 'local') {
    return createLocalProvider(options.local);
  }

  throw new TheorumError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}

exposeForTests('create-provider', { isSpeechRole, createProvider, lazyOpenRouterChat });
