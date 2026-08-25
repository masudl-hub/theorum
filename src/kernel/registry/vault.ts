/**
 * Gemini vault slot selection for Google Interactions transport.
 *
 * Host-owned policy over `ModelSpec.key` / `keyBuiltins`. Pure; no network.
 *
 * @module
 */

import type { BuiltinToolId, GeminiBucket, GeminiFreeBucket, ModelSpec } from '../types.ts';

/** Pick the vault slot for a turn from profile key, model pin, and builtins. */
function resolveGeminiBucket(
  profileKey: GeminiFreeBucket,
  spec: ModelSpec,
  builtins: BuiltinToolId[],
): GeminiBucket {
  if (spec.key) {
    return spec.key;
  }
  if (builtins.some((id) => !spec.keyBuiltins.includes(id))) {
    return 'paid';
  }
  return profileKey;
}

export { resolveGeminiBucket };
