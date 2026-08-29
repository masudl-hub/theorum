/**
 * Compaction helpers for splitting conversation history.
 *
 * `splitForCompaction` is a pure function — it does not call providers or
 * manage state. Hosts and the runner call it to partition history into a
 * compactable segment and a retained tail.
 *
 * @module
 */

import type { CompactionSpec, TurnHistoryMessage } from '../types.ts';

/** Result of splitting history for compaction. */
export interface CompactionSplit {
  /** Messages to send to the compaction profile. */
  toCompact: TurnHistoryMessage[];
  /** Recent exchanges to preserve verbatim. */
  toRetain: TurnHistoryMessage[];
}

/**
 * Find exchange boundaries in a history array.
 *
 * An exchange starts at each `user` message and includes all subsequent
 * messages until the next `user` message. System messages before the first
 * user message are not part of any exchange.
 *
 * Returns the indices of each `user` message that starts an exchange.
 */
function findExchangeBoundaries(history: TurnHistoryMessage[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') {
      boundaries.push(i);
    }
  }
  return boundaries;
}

function estimateTokens(messages: TurnHistoryMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.content) chars += msg.content.length;
    if (msg.parts) {
      for (const part of msg.parts) {
        if ('text' in part) chars += part.text.length;
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Whether compaction should fire based on the previous turn's input token count.
 */
export function compactionNeeded(
  lastInputTokens: number,
  spec: CompactionSpec,
): boolean {
  return lastInputTokens > spec.compactAt * spec.maxHistoryTokens;
}

/**
 * Split history into compactable and retained segments.
 *
 * `previousExchanges` semantics:
 * - `0` — compact everything, retain nothing.
 * - `≥ 1` (integer) — retain the last N exchanges.
 * - `(0, 1)` — retain exchanges that fit within this fraction of `maxHistoryTokens`,
 *   walking backwards from the most recent.
 */
export function splitForCompaction(
  history: TurnHistoryMessage[],
  spec: CompactionSpec,
): CompactionSplit {
  if (history.length === 0) {
    return { toCompact: [], toRetain: [] };
  }

  if (spec.previousExchanges === 0) {
    return { toCompact: [...history], toRetain: [] };
  }

  const boundaries = findExchangeBoundaries(history);

  if (boundaries.length === 0) {
    return { toCompact: [...history], toRetain: [] };
  }

  let cutIndex: number;

  if (spec.previousExchanges >= 1) {
    const keep = Math.min(spec.previousExchanges, boundaries.length);
    cutIndex = boundaries[boundaries.length - keep];
  } else {
    const budget = spec.previousExchanges * spec.maxHistoryTokens;
    let accumulated = 0;
    cutIndex = history.length;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      const exchangeStart = boundaries[i];
      const exchangeEnd = i < boundaries.length - 1 ? boundaries[i + 1] : history.length;
      const exchangeMessages = history.slice(exchangeStart, exchangeEnd);
      const exchangeTokens = estimateTokens(exchangeMessages);
      if (accumulated + exchangeTokens > budget) {
        break;
      }
      accumulated += exchangeTokens;
      cutIndex = exchangeStart;
    }
  }

  if (cutIndex <= 0) {
    return { toCompact: [], toRetain: [...history] };
  }

  return {
    toCompact: history.slice(0, cutIndex),
    toRetain: history.slice(cutIndex),
  };
}
