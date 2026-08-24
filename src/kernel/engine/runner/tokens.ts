import type { TurnEvent, TurnRequest } from '../../types.ts';

function calculateInputChars(safe: TurnRequest, system: string): number {
  const input = safe.input ?? {};
  return (
    (input.text?.length ?? 0) +
    (input.repair?.previousOutput?.length ?? 0) +
    (system?.length ?? 800)
  );
}

function calculateOutputChars(events: TurnEvent[]): { outputChars: number; thinkingChars: number } {
  let outputChars = 0;
  let thinkingChars = 0;
  for (const e of events) {
    if (e.type === 'text' && e.text) outputChars += e.text.length;
    if (e.type === 'structured' && e.structured) {
      outputChars += JSON.stringify(e.structured).length;
    }
    if (e.type === 'thought' && e.text) thinkingChars += e.text.length;
  }
  return { outputChars, thinkingChars };
}

function* calculateFallbackTokens(
  safe: TurnRequest,
  system: string,
  events: TurnEvent[],
): Generator<TurnEvent> {
  const inputChars = calculateInputChars(safe, system);
  const { outputChars, thinkingChars } = calculateOutputChars(events);
  const inputTokens = Math.max(1, Math.round(inputChars / 4));
  const outputTokens = Math.max(1, Math.round(outputChars / 4));
  const thinkingTokens = thinkingChars ? Math.round(thinkingChars / 4) : 0;
  yield {
    type: 'tokens',
    tokens: {
      input: inputTokens,
      output: outputTokens,
      thinking: thinkingTokens,
      toolUse: 0,
      total: inputTokens + outputTokens + thinkingTokens,
    },
  };
}

export { calculateFallbackTokens };
