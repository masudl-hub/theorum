/**
 * Gemini vault slot selection for Google Interactions transport.
 *
 * @module
 */

import { getTool } from '../tools/registry.ts';
import type { BuiltinToolDef } from '../tools/types.ts';
import type { BuiltinToolId, GeminiBucket, GeminiFreeBucket, ModelSpec } from '../types.ts';

function builtinForcesPaid(id: BuiltinToolId): boolean {
  const tool = getTool(id);
  if (tool?.type !== 'builtin') {
    return false;
  }
  return (tool as BuiltinToolDef).forcePaidKey === true;
}

/** Pick the vault slot for a turn from profile key, model pin, and enabled builtins. */
function resolveGeminiBucket(
  profileKey: GeminiFreeBucket,
  spec: ModelSpec,
  builtins: BuiltinToolId[],
): GeminiBucket {
  if (spec.key) {
    return spec.key;
  }
  if (builtins.some((id) => builtinForcesPaid(id))) {
    return 'paid';
  }
  return profileKey;
}

export { resolveGeminiBucket };
