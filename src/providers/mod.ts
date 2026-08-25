/**
 * Provider adapters for THEORUM's `ModelProvider` contract.
 *
 * Host apps should use `createProvider(profile, options)` — the single door.
 * Credentials are always supplied by the host application.
 *
 * @module
 */

export type { CreateProviderOptions } from './create-provider.ts';
export { createProvider } from './create-provider.ts';
export type { GeminiTransport, GeminiVault } from './keys.ts';
