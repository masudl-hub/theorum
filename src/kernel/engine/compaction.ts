/**
 * Compaction helpers: history split + threshold metering.
 *
 * Pure and stateless. History lives on the request; the kernel does not store
 * cross-turn session state.
 *
 * @module
 */

import type {
  CompactionMeter,
  CompactionSpec,
  CompactionTriggerContext,
  TurnHistoryMessage,
  TurnInput,
} from '../types.ts';
import { estimateHistoryTokens } from './history-tokens.ts';

export {
  estimateHistoryTokens,
  HISTORY_MEDIA_TOKENS,
  HISTORY_TEXT_ENCODING,
} from './history-tokens.ts';

/** Result of splitting history for compaction. */
export interface CompactionSplit {
  /** Messages to send to the compaction profile. */
  toCompact: TurnHistoryMessage[];
  /** Recent exchanges to preserve verbatim. */
  toRetain: TurnHistoryMessage[];
}

/** Resolved meter for a compaction decision. */
export interface CompactionTokens {
  meter: CompactionMeter;
  /** Token count compared to `compactAt * maxTokens`. */
  tokens: number;
}

/** Effective meter; defaults to `'history'`. */
export function compactionMeter(spec: CompactionSpec): CompactionMeter {
  return spec.meter ?? 'history';
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

/**
 * History token count for `meter: 'history'`.
 *
 * Prefers host-supplied `input.historyTokens`. Otherwise estimates from
 * `input.history` (tiktoken `o200k_base` + media stubs). Empty/missing → 0.
 * The BPE import runs only when an estimate needs text encoding.
 */
export async function resolveHistoryTokens(input?: TurnInput): Promise<number> {
  if (input?.historyTokens != null) {
    return input.historyTokens;
  }
  return await estimateHistoryTokens(input?.history ?? []);
}

/**
 * Resolve the token count used for the compaction threshold.
 *
 * - `meter: 'history'` (default) — `historyTokens` or estimate of `history`.
 * - `meter: 'input'` — prefer `promptTokens` (this turn's provider
 *   `tokens.input`, for `timing: 'after'`), else host `input.inputTokens`
 *   (previous turn, for `timing: 'before'`). Missing/non-positive → undefined
 *   (do not fire).
 *
 * `meter: 'input'` never loads the history tokenizer.
 */
export async function resolveCompactionTokens(args: {
  spec: CompactionSpec;
  input?: TurnInput;
  /** Provider full-prompt input tokens from this turn, when known. */
  promptTokens?: number;
}): Promise<CompactionTokens | undefined> {
  const meter = compactionMeter(args.spec);
  if (meter === 'history') {
    return { meter, tokens: await resolveHistoryTokens(args.input) };
  }
  const fromPrompt =
    args.promptTokens != null && args.promptTokens > 0 ? args.promptTokens : undefined;
  const fromHost =
    args.input?.inputTokens != null && args.input.inputTokens > 0
      ? args.input.inputTokens
      : undefined;
  const tokens = fromPrompt ?? fromHost;
  if (tokens == null) return undefined;
  return { meter, tokens };
}

/** Whether compaction should fire for a resolved token count (token-threshold only). */
export function compactionNeeded(tokens: number, spec: CompactionSpec): boolean {
  return tokens > spec.compactAt * spec.maxTokens;
}

/**
 * Whether compaction should fire, respecting a custom trigger when provided.
 *
 * When `spec.trigger` is set, it is called with full context and its result
 * is returned directly. Otherwise falls back to `compactionNeeded`.
 */
export async function shouldCompact(
  resolved: CompactionTokens,
  spec: CompactionSpec,
): Promise<boolean> {
  if (spec.trigger) {
    const ctx: CompactionTriggerContext = {
      tokens: resolved.tokens,
      maxTokens: spec.maxTokens,
      compactAt: spec.compactAt,
      meter: resolved.meter,
    };
    return await spec.trigger(ctx);
  }
  return compactionNeeded(resolved.tokens, spec);
}

/**
 * Split history into compactable and retained segments.
 *
 * `previousExchanges` semantics:
 * - `0` — compact everything, retain nothing.
 * - `≥ 1` (integer) — retain the last N exchanges.
 * - `(0, 1)` — retain exchanges that fit within this fraction of `maxTokens`,
 *   walking backwards from the most recent (always uses the history estimator).
 */
export async function splitForCompaction(
  history: TurnHistoryMessage[],
  spec: CompactionSpec,
): Promise<CompactionSplit> {
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
    const budget = spec.previousExchanges * spec.maxTokens;
    let accumulated = 0;
    cutIndex = history.length;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      const exchangeStart = boundaries[i];
      const exchangeEnd = i < boundaries.length - 1 ? boundaries[i + 1] : history.length;
      const exchangeMessages = history.slice(exchangeStart, exchangeEnd);
      const exchangeTokens = await estimateHistoryTokens(exchangeMessages);
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
