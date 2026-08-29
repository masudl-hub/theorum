import '../fixtures/test-host.ts';
import '../fixtures/enable-test-internals.ts';
import { testInternals } from '../fixtures/testInternals.ts';
import { TheorumError, UPSTREAM_FAILED } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import {
  fetchGemini,
  type GeminiVault,
  withGeminiKey,
} from '../../src/providers/keys.ts';

const {
  waitDefault,
  isQuota,
  isTransientHttp,
  isTransientThrown,
  requireKey,
  backoffMs,
  canOverflow,
  withApiKey,
} = testInternals('keys');

const vault: GeminiVault = {
  freeA: 'free-a-key',
  freeB: 'free-b-key',
  freeC: 'free-c-key',
  paid: 'paid-key',
};

const HTTP_OK = 200;
const HTTP_QUOTA = 429;

function noWait(): Promise<void> {
  return Promise.resolve();
}

function headerApiKey(init?: RequestInit): string {
  return new Headers(init?.headers).get('x-goog-api-key') ?? '';
}

function responseForKey(key: string): Response {
  if (key === 'paid-key') {
    return new Response('body', { status: HTTP_OK });
  }
  return new Response('body', { status: HTTP_QUOTA });
}

Deno.test('host profiles default to their configured free key slots', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', input: { text: 'x' } }).generation.geminiBucket,
    'freeA',
  );
  assertEquals(resolveTurn({ profile: 'pinned', input: {} }).generation.geminiBucket, 'freeA');
  assertEquals(
    resolveTurn({ profile: 'formatter', input: { text: 'x' } }).generation.geminiBucket,
    'freeC',
  );
  assertEquals(
    resolveTurn({ profile: 'selector', select: 'fast', input: { text: 'x' } }).generation
      .geminiBucket,
    'freeB',
  );
});

Deno.test('image model uses the paid Gemini key', () => {
  assertEquals(
    resolveTurn({ profile: 'image', input: { text: 'fox' } }).generation.geminiBucket,
    'paid',
  );
});

Deno.test('pro preview without search or maps stays on the configured free key', () => {
  const { generation } = resolveTurn({
    profile: 'selector',
    select: 'smart',
    input: { text: 'x' },
  });
  assertEquals(generation.model, 'gemini31ProPreview');
  assertEquals(generation.geminiBucket, 'freeB');
});

Deno.test('search forces the paid key on every free profile', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', tools: { googleSearch: true }, input: { text: 'x' } }).generation
      .geminiBucket,
    'paid',
  );
  assertEquals(
    resolveTurn({ profile: 'formatter', tools: { googleSearch: true }, input: { text: 'x' } })
      .generation.geminiBucket,
    'paid',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector',
      select: 'fast',
      tools: { googleSearch: true },
      input: { text: 'x' },
    }).generation.geminiBucket,
    'paid',
  );
});

Deno.test('maps on flash lite stays free; maps on pro preview is paid', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', tools: { googleMaps: true }, input: { text: 'x' } }).generation
      .geminiBucket,
    'freeA',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector',
      select: 'fast',
      tools: { googleMaps: true },
      input: { text: 'x' },
    }).generation.geminiBucket,
    'freeB',
  );
  assertEquals(
    resolveTurn({
      profile: 'selector',
      select: 'smart',
      tools: { googleMaps: true },
      input: { text: 'x' },
    }).generation.geminiBucket,
    'paid',
  );
});

Deno.test('url context does not force paid', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', tools: { urlContext: true }, input: { text: 'x' } }).generation
      .geminiBucket,
    'freeA',
  );
});

Deno.test('withGeminiKey stays on the free key when it succeeds', async () => {
  const used: string[] = [];
  const out = await withGeminiKey(
    'freeA',
    (apiKey) => {
      used.push(apiKey);
      return Promise.resolve('ok');
    },
    { vault, wait: noWait },
  );
  assertEquals(out, 'ok');
  assertEquals(used, ['free-a-key']);
});

Deno.test('withGeminiKey overflows to paid after quota backoff on a free bucket', async () => {
  const used: string[] = [];
  const out = await withGeminiKey(
    'freeC',
    (apiKey) => {
      used.push(apiKey);
      if (apiKey !== 'paid-key') {
        return Promise.reject(new Error('429 RESOURCE_EXHAUSTED'));
      }
      return Promise.resolve('ok');
    },
    { vault, wait: noWait },
  );
  assertEquals(out, 'ok');
  assertEquals(used, ['free-c-key', 'free-c-key', 'free-c-key', 'paid-key']);
});

Deno.test('withGeminiKey never overflows when the bucket is already paid', async () => {
  const used: string[] = [];
  let threw = false;
  try {
    await withGeminiKey(
      'paid',
      (apiKey) => {
        used.push(apiKey);
        return Promise.reject(new Error('429'));
      },
      { vault, wait: noWait },
    );
  } catch (err) {
    threw = err instanceof Error && err.message === '429';
  }
  assertEquals(threw, true);
  assertEquals(used, ['paid-key', 'paid-key', 'paid-key']);
});

Deno.test('fetchGemini never starts on paid for a free bucket that is not 429', async () => {
  const used: string[] = [];
  const res = await fetchGemini('https://example.com/v1', { method: 'POST', body: '{}' }, 'freeB', {
    vault,
    wait: noWait,
    fetch: (_url, init) => {
      used.push(headerApiKey(init));
      return Promise.resolve(new Response('ok', { status: HTTP_OK }));
    },
  });
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-b-key']);
});

Deno.test('fetchGemini overflows to paid after 429 backoff, not before', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1?key=strip-me',
    { method: 'POST', body: '{}' },
    'freeA',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => {
        const key = headerApiKey(init);
        used.push(key);
        return Promise.resolve(responseForKey(key));
      },
    },
  );
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['free-a-key', 'free-a-key', 'free-a-key', 'paid-key']);
});

Deno.test('missing free key throws before any fetch', async () => {
  let threw = false;
  try {
    await fetchGemini('https://example.com/v1', {}, 'freeC', {
      vault: { ...vault, freeC: undefined },
      wait: noWait,
      fetch: () => {
        throw new Error('must not fetch');
      },
    });
  } catch (err) {
    threw = err instanceof TheorumError && err.message === UPSTREAM_FAILED;
  }
  assertEquals(threw, true);
});

Deno.test('fetchGemini and withGeminiKey retry on transient network errors before succeeding', async () => {
  let attempts = 0;
  const res = await fetchGemini('https://example.com/v1/ping', { method: 'GET' }, 'freeA', {
    vault,
    wait: noWait,
    fetch: () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('fetch failed: network error socket'));
      }
      return Promise.resolve(new Response('pong', { status: HTTP_OK }));
    },
  });
  assertEquals(res.status, HTTP_OK);
  assertEquals(attempts, 2);

  let keyAttempts = 0;
  const result = await withGeminiKey(
    'freeA',
    () => {
      keyAttempts++;
      if (keyAttempts === 1) {
        return Promise.reject(new Error('network connection reset'));
      }
      return Promise.resolve('data');
    },
    { vault, wait: noWait },
  );
  assertEquals(result, 'data');
  assertEquals(keyAttempts, 2);
});

Deno.test('isQuota detects quota-shaped errors', () => {
  assertEquals(isQuota('429'), true);
  assertEquals(isQuota('RESOURCE_EXHAUSTED'), true);
  assertEquals(isQuota('quota'), true);
  assertEquals(isQuota('500'), false);
  assertEquals(isQuota('not found'), false);
});

Deno.test('isTransientHttp flags retryable status codes only', () => {
  assertEquals(isTransientHttp(408), true);
  assertEquals(isTransientHttp(429), true);
  assertEquals(isTransientHttp(500), true);
  assertEquals(isTransientHttp(502), true);
  assertEquals(isTransientHttp(503), true);
  assertEquals(isTransientHttp(504), true);
  assertEquals(isTransientHttp(200), false);
  assertEquals(isTransientHttp(400), false);
  assertEquals(isTransientHttp(401), false);
  assertEquals(isTransientHttp(403), false);
  assertEquals(isTransientHttp(404), false);
});

Deno.test('isTransientThrown matches known transient network error shapes', () => {
  assertEquals(isTransientThrown(new Error('dns lookup failed')), true);
  assertEquals(isTransientThrown(new Error('ECONNRESET')), true);
  assertEquals(isTransientThrown(new Error('fetch failed')), true);
  assertEquals(isTransientThrown(new Error('503 service unavailable')), true);
  assertEquals(isTransientThrown(new Error('socket hang up')), true);
  assertEquals(isTransientThrown(new Error('temporarily unavailable')), true);
});

Deno.test('isTransientThrown never retries abort errors', () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  assertEquals(isTransientThrown(abort), false);
});

Deno.test('isTransientThrown is false for unrelated errors', () => {
  assertEquals(isTransientThrown(new Error('invalid input')), false);
});

Deno.test('backoffMs follows the configured schedule and falls back after it', () => {
  assertEquals(backoffMs(0), 1000);
  assertEquals(backoffMs(1), 2000);
  assertEquals(backoffMs(2), 4000);
  assertEquals(backoffMs(3), 2000);
  assertEquals(backoffMs(10), 2000);
});

Deno.test('canOverflow only offers the paid key for a distinct free bucket', () => {
  assertEquals(canOverflow('paid', vault, vault.paid ?? ''), undefined);
  assertEquals(canOverflow('freeA', { ...vault, paid: undefined }, 'free-a-key'), undefined);
  assertEquals(canOverflow('freeA', vault, 'paid-key'), undefined);
  assertEquals(canOverflow('freeA', vault, 'free-a-key'), 'paid-key');
});

Deno.test('withApiKey sets the api key header and Content-Type for non-GET requests', () => {
  const init = withApiKey({ method: 'POST' }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('x-goog-api-key'), 'my-key');
  assertEquals(headers.get('Content-Type'), 'application/json');
});

Deno.test('withApiKey preserves an existing Content-Type header', () => {
  const init = withApiKey({ method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('Content-Type'), 'text/plain');
});

Deno.test('withApiKey does not set Content-Type for GET requests', () => {
  const init = withApiKey({ method: 'GET' }, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('x-goog-api-key'), 'my-key');
  assertEquals(headers.get('Content-Type'), null);
});

Deno.test('withApiKey defaults to GET behavior when no method is given', () => {
  const init = withApiKey({}, 'my-key');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('Content-Type'), null);
});

Deno.test('requireKey throws TheorumError when the bucket has no key', () => {
  let threw = false;
  try {
    requireKey({ ...vault, freeA: undefined }, 'freeA');
  } catch (err) {
    threw = err instanceof TheorumError && err.message === UPSTREAM_FAILED;
  }
  assertEquals(threw, true);
});

Deno.test('requireKey returns the key when present', () => {
  assertEquals(requireKey(vault, 'freeA'), 'free-a-key');
});

Deno.test('waitDefault returns a promise', () => {
  const result = waitDefault(0) as unknown as Promise<void>;
  assertEquals(typeof result.then, 'function');
});
