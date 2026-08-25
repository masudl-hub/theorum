/**
 * Generic inbound and outbound guardrail primitives.
 *
 * This entrypoint exposes public-safe error mapping, prompt-injection span
 * detection, sensitive-data span detection, and request sanitization. App-
 * specific policy remains host-owned.
 *
 * @module
 */

export {
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_FILE_COUNT,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_TYPE,
  PUBLIC_GENERIC,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_UNAVAILABLE,
  describeError,
  publicError,
  TheorumError,
  toErrorEvent,
  UPSTREAM_FAILED,
} from './error.ts';
export { injectionSpans } from './injection.ts';
export type { QuotaSlotStatus } from './quota.ts';
export {
  clientIp,
  quotaMessage,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './quota.ts';
export {
  PROJECT_ID_MAX,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
} from './sanitize.ts';
export { sensitiveSpans } from './sensitive.ts';
