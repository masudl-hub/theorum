/**
 * Guardrails testing surface — adversarial corpus, fuzz runners, live attack builders.
 *
 * Import via `theorum/guardrails/testing` (not published on the production guardrails entry).
 *
 * @module
 */

export {
  buildCanaryEgressAttacks,
  buildLiveAttacks,
  canaryEgressCatalog,
  filterLiveAttacks,
  FIXED_CANARY,
  inboundFuzzPayloads,
  inboundPayloadByName,
  runInboundGuardrailFuzz,
  summarizeAttackBank,
} from './corpus/mod.ts';
export type {
  CanaryEgressAttack,
  CanaryEgressCatalogEntry,
  InboundFuzzPayload,
  InboundFuzzResult,
  LiveAttack,
} from './corpus/mod.ts';
