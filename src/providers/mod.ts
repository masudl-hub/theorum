/**
 * Provider adapters for THEORUM's `ModelProvider` contract.
 *
 * Host apps should use `createProvider(profile, options)` — the single door.
 * Credentials are always supplied by the host application.
 *
 * For direct local adapter access (bypassing the factory), import
 * `@theorum/core/providers/local`.
 *
 * @module
 */

export type { CreateProviderOptions } from './create-provider.ts';
export { createProvider } from './create-provider.ts';
export type { GeminiTransport, GeminiVault } from './google/keys.ts';
export type { LocalProviderConfig, OpenAiGatewayConfig } from './types.ts';
