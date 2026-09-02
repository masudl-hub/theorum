/** @module Re-export — Live canary batch gate lives in `src/guardrails/canary-gate.ts`. */
export type { CanaryGateSession } from '../../guardrails/canary-gate.ts';
export { createCanaryGateSession, filterCanaryGatedEvents } from '../../guardrails/canary-gate.ts';
