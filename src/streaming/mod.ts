/**
 * Structured-output streaming helpers and turn-stop classification.
 *
 * @module
 */

export type {
  ProfileResumeSpec,
  TurnContinueFrom,
  TurnStop,
  TurnStopKind,
} from '../kernel/stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION,
  DEFAULT_AUTO_CONTINUE,
  GenerationStopError,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenRouter,
} from '../kernel/stop.ts';
export { readStreamingJsonStringField } from './readStreamingJsonStringField.ts';
