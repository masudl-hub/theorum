/** @module Re-export — canary implementation lives in `src/guardrails/canary.ts`. */
export type { CanaryGateResult, CanaryStreamGate } from '../../guardrails/canary.ts';
export {
  bindCanary,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
} from '../../guardrails/canary.ts';
