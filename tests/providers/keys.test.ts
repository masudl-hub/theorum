import '../fixtures/test-host.ts';
import { TheorumError, UPSTREAM_FAILED } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { fetchGemini, type GeminiVault, withGeminiKey } from '../../src/providers/keys.ts';

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
