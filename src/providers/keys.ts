/**
 * Gemini key vault selection, quota overflow, and fetch retries.
 *
 * Host applications supply vault credentials through `GeminiTransport`.
 * THEORUM does not read environment variables for these keys.
 *
 * @module
 */

import { isAbortError, TheorumError, UPSTREAM_FAILED } from '../guardrails/error.ts';
import type { GeminiBucket } from '../kernel/types.ts';

type GeminiVault = Record<GeminiBucket, string | undefined>;

interface GeminiTransport {
  vault: GeminiVault;
  wait?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const ATTEMPTS = 3;
const LAST_ATTEMPT = ATTEMPTS - 1;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_SECOND_MS = 2000;
const BACKOFF_THIRD_MS = 4000;
const BACKOFF_MS = [BACKOFF_FIRST_MS, BACKOFF_SECOND_MS, BACKOFF_THIRD_MS];

const HTTP_TIMEOUT = 408;
const HTTP_QUOTA = 429;
const HTTP_SERVER = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;

const QUOTA_RE = /quota/i;
const TRANSIENT_THROWN_RE =
  /name resolution|dns|econnreset|econnrefused|etimedout|network|fetch failed|temporarily unavailable|socket|503|502|504/i;

function waitDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isQuota(err: unknown): boolean {
  const s = String(err);
  return s.includes(String(HTTP_QUOTA)) || s.includes('RESOURCE_EXHAUSTED') || QUOTA_RE.test(s);
}

function isTransientHttp(status: number): boolean {
  return (
    status === HTTP_TIMEOUT ||
    status === HTTP_QUOTA ||
    status === HTTP_SERVER ||
    status === HTTP_BAD_GATEWAY ||
    status === HTTP_UNAVAILABLE ||
    status === HTTP_GATEWAY_TIMEOUT
  );
}

function isTransientThrown(err: unknown): boolean {
  if (isAbortError(err)) {
    return false;
  }
  return TRANSIENT_THROWN_RE.test(String(err));
}

function requireKey(vault: GeminiVault, bucket: GeminiBucket): string {
  const key = vault[bucket];
  if (!key) {
    throw new TheorumError(UPSTREAM_FAILED);
  }
  return key;
}

function backoffMs(attempt: number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_SECOND_MS;
}

async function runWithBackoff<T>(
  apiKey: string,
  run: (apiKey: string) => Promise<T>,
  wait: (ms: number) => Promise<void>,
  attempt: number,
): Promise<T> {
  try {
    return await run(apiKey);
  } catch (err) {
    if (
      isAbortError(err) ||
      !(isQuota(err) || isTransientThrown(err)) ||
      attempt === LAST_ATTEMPT
    ) {
      throw err;
    }
    await wait(backoffMs(attempt));
    return runWithBackoff(apiKey, run, wait, attempt + 1);
  }
}

function canOverflow(
  bucket: GeminiBucket,
  vault: GeminiVault,
  primary: string,
): string | undefined {
  if (bucket === 'paid') {
    return undefined;
  }
  const { paid } = vault;
  if (!paid || paid === primary) {
    return undefined;
  }
  return paid;
}

async function withGeminiKey<T>(
  bucket: GeminiBucket,
  run: (apiKey: string) => Promise<T>,
  transport: GeminiTransport,
): Promise<T> {
  const wait = transport.wait ?? waitDefault;
  const primary = requireKey(transport.vault, bucket);
  try {
    return await runWithBackoff(primary, run, wait, 0);
  } catch (err) {
    const paid = canOverflow(bucket, transport.vault, primary);
    if (!(isQuota(err) && paid)) {
      throw err;
    }
    return await runWithBackoff(paid, run, wait, 0);
  }
}

function withApiKey(init: RequestInit, apiKey: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('x-goog-api-key', apiKey);
  if (!headers.has('Content-Type') && (init.method || 'GET').toUpperCase() !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }
  return { ...init, headers };
}

interface FetchAttempt {
  href: string;
  init: RequestInit;
  apiKey: string;
  transport: GeminiTransport;
  attempt: number;
}

async function fetchWithBackoff(args: FetchAttempt): Promise<Response> {
  const wait = args.transport.wait ?? waitDefault;
  const send = args.transport.fetch ?? fetch;
  try {
    const last = await send(args.href, withApiKey(args.init, args.apiKey));
    if (!isTransientHttp(last.status) || args.attempt === LAST_ATTEMPT) {
      return last;
    }
    if (args.init.signal?.aborted) {
      throw args.init.signal.reason instanceof Error
        ? args.init.signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
    }
    await wait(backoffMs(args.attempt));
    return fetchWithBackoff({ ...args, attempt: args.attempt + 1 });
  } catch (err) {
    if (isAbortError(err) || !isTransientThrown(err) || args.attempt === LAST_ATTEMPT) {
      throw err;
    }
    await wait(backoffMs(args.attempt));
    return fetchWithBackoff({ ...args, attempt: args.attempt + 1 });
  }
}

async function fetchGemini(
  url: string,
  init: RequestInit,
  bucket: GeminiBucket,
  transport: GeminiTransport,
): Promise<Response> {
  const parsed = new URL(url);
  parsed.searchParams.delete('key');
  const href = parsed.toString();
  const primary = requireKey(transport.vault, bucket);
  let last = await fetchWithBackoff({ href, init, apiKey: primary, transport, attempt: 0 });
  const paid = canOverflow(bucket, transport.vault, primary);
  if (last.status === HTTP_QUOTA && paid) {
    last = await fetchWithBackoff({ href, init, apiKey: paid, transport, attempt: 0 });
  }
  return last;
}

export type { GeminiTransport, GeminiVault };
export { fetchGemini, withGeminiKey };

/** @internal Exported for direct unit testing only. */
export const _internals = {
  waitDefault,
  isQuota,
  isTransientHttp,
  isTransientThrown,
  requireKey,
  backoffMs,
  canOverflow,
  withApiKey,
};
