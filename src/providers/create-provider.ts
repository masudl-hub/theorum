/**
 * Host provider factory — the single public door for binding a profile to a transport.
 *
 * Routes from `profile.model.protocol` / `provider` (and whether the profile is
 * a speech role). Adapters under this folder are internal implementation.
 *
 * Every adapter graph is loaded only when that transport's first `complete` runs —
 * not when this module is imported.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import { isValidPair } from '../kernel/schema.ts';
import type {
  ModelProvider,
  Profile,
  ProviderCompleteRequest,
  TurnEvent,
} from '../kernel/types.ts';
import { exposeForTests } from './expose-for-tests.ts';
import type { GeminiTransport } from './google/keys.ts';
import type { LocalProviderConfig, OpenAiGatewayConfig } from './types.ts';

/** Credentials supplied by the host when creating a provider. */
export interface CreateProviderOptions {
  /** Google Interactions (chat, image, and speech when protocol is geminiInteractions). */
  gemini?: GeminiTransport;
  /**
   * OpenAI-gateway credentials for `openAi` profiles (OpenRouter or compatible).
   * Used for chat completions or `/audio/speech` when the profile is a speech role.
   * Optional `voice` is a fallback when `outputs.speech.voice` is omitted.
   */
  openAiGateway?: OpenAiGatewayConfig & { voice?: string };
  /** Local OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio). */
  local?: LocalProviderConfig;
}

function isSpeechRole(profile: Profile): boolean {
  return profile.outputs.speech !== undefined;
}

function lazyAdapter(load: () => Promise<ModelProvider>): ModelProvider {
  let pending: Promise<ModelProvider> | undefined;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      pending ??= load();
      yield* (await pending).complete(req);
    },
  };
}

function lazyOpenRouterChat(config: OpenAiGatewayConfig): ModelProvider {
  return lazyAdapter(() =>
    import('./openrouter/chat.ts').then((m) => m.createOpenRouterProvider(config)),
  );
}

function lazyGoogleInteractions(config: GeminiTransport): ModelProvider {
  return lazyAdapter(() =>
    import('./google/google-interactions.ts').then((m) => m.createInteractionsProvider(config)),
  );
}

function lazySpeech(config: OpenAiGatewayConfig & { voice?: string }): ModelProvider {
  return lazyAdapter(() =>
    import('./openrouter/speech.ts').then((m) => m.createSpeechProvider(config)),
  );
}

function lazyLocal(config?: LocalProviderConfig): ModelProvider {
  return lazyAdapter(() => import('./local/local.ts').then((m) => m.createLocalProvider(config)));
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

  if (!isValidPair(protocol, provider)) {
    throw new TheorumError(
      `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
    );
  }

  if (protocol === 'geminiInteractions' && provider === 'google') {
    if (!options.gemini) {
      throw new TheorumError('createProvider requires gemini transport for google Interactions');
    }
    return lazyGoogleInteractions(options.gemini);
  }

  if (protocol === 'openAi' && provider === 'openrouter') {
    if (!options.openAiGateway) {
      throw new TheorumError('createProvider requires openAiGateway config for openAi/openrouter');
    }
    if (isSpeechRole(profile)) {
      return lazySpeech(options.openAiGateway);
    }
    return lazyOpenRouterChat(options.openAiGateway);
  }

  if (protocol === 'openAi' && provider === 'local') {
    return lazyLocal(options.local);
  }

  // Exhaustiveness guard: isValidPair above already rejects unknown pairs, so
  // this throw is unreachable at runtime. It exists so TypeScript errors if a
  // new protocol/provider is added to PROTOCOL_PROVIDERS without a branch here.
  throw new TheorumError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}

exposeForTests('create-provider', {
  isSpeechRole,
  createProvider,
  lazyOpenRouterChat,
  lazyGoogleInteractions,
  lazySpeech,
  lazyLocal,
});
