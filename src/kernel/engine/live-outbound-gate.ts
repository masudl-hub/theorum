/** @module Re-export — Live outbound gate lives in `src/guardrails/live-outbound-gate.ts`. */
export type {
  LiveOutboundBatchResult,
  LiveOutboundGateSession,
} from '../../guardrails/live-outbound-gate.ts';
export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../guardrails/live-outbound-gate.ts';
