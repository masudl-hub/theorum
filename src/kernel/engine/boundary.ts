/** @module Re-export — canary implementation lives in `src/guardrails/canary.ts`. */
export type { CanaryStreamGate } from '../../guardrails/canary.ts';
export {
  bindCanary,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  wrapUserData,
} from '../../guardrails/canary.ts';
