/** OpenAI-gateway credentials for `openAi` profiles (OpenRouter or compatible). */
export interface OpenAiGatewayConfig {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
}

/** Host-supplied config for the local OpenAI-compat provider. */
export interface LocalProviderConfig {
  /**
   * Base URL of the OpenAI-compat server (no trailing slash).
   * Defaults to `http://127.0.0.1:11434`.
   */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
