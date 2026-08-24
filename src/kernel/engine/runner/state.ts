import type {
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';

interface StepExecutionState {
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  sawTokensEvent: boolean;
  allEmittedEvents: TurnEvent[];
  attemptEvents: TurnEvent[];
}

interface AttemptFlowState {
  currentAttempt: number;
  currentReq: TurnRequest;
  currentGen: ResolvedGeneration;
}

function recordStepEvent(event: TurnEvent, state: StepExecutionState): void {
  if (event.type === 'tokens') {
    state.sawTokensEvent = true;
  }
  state.allEmittedEvents.push(event);
  state.attemptEvents.push(event);
}

export type { AttemptFlowState, StepExecutionState };
export { recordStepEvent };
