import '../fixtures/test-host.ts';
import { TheorumError, UPSTREAM_FAILED } from '../../src/guardrails/error.ts';
import {
  fetchGemini,
  type GeminiVault,
  vaultFromEnv,
  withGeminiKey,
} from '../../src/guardrails/keys.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';

const vault: GeminiVault = {
  studio: 'studio-key',
  portfolio: 'portfolio-key',
  planner: 'planner-key',
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

Deno.test('vaultFromEnv exposes every Gemini bucket', () => {
  assertEquals(Object.keys(vaultFromEnv()).sort(), ['paid', 'planner', 'portfolio', 'studio']);
});

Deno.test('mermaid daily studio planner default to their free keys', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', input: { text: 'x' } }).generation.geminiBucket,
    'portfolio',
  );
  assertEquals(resolveTurn({ profile: 'pinned', input: {} }).generation.geminiBucket, 'portfolio');
  assertEquals(
    resolveTurn({ profile: 'designer', input: { text: 'x' } }).generation.geminiBucket,
    'studio',
  );
  assertEquals(
    resolveTurn({ profile: 'picker', select: 'fast', input: { text: 'x' } }).generation
      .geminiBucket,
    'planner',
  );
});

Deno.test('vinylator image model uses GEMINI_API_KEY', () => {
  assertEquals(
    resolveTurn({ profile: 'image', input: { text: 'fox' } }).generation.geminiBucket,
    'paid',
  );
});

Deno.test('3.7 flash without search or maps stays on the free planner key', () => {
  const { generation } = resolveTurn({ profile: 'picker', select: 'smart', input: { text: 'x' } });
  assertEquals(generation.model, 'gemini37Flash');
  assertEquals(generation.geminiBucket, 'planner');
});

Deno.test('search forces the paid key on every free profile', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', tools: { googleSearch: true }, input: { text: 'x' } }).generation
      .geminiBucket,
    'paid',
  );
  assertEquals(
    resolveTurn({ profile: 'designer', tools: { googleSearch: true }, input: { text: 'x' } })
      .generation.geminiBucket,
    'paid',
  );
  assertEquals(
    resolveTurn({
      profile: 'picker',
      select: 'fast',
      tools: { googleSearch: true },
      input: { text: 'x' },
    }).generation.geminiBucket,
    'paid',
  );
});

Deno.test('maps on flash lite stays free; maps on 3.7 flash is paid', () => {
  assertEquals(
    resolveTurn({ profile: 'chat', tools: { googleMaps: true }, input: { text: 'x' } }).generation
      .geminiBucket,
    'portfolio',
  );
  assertEquals(
    resolveTurn({
      profile: 'picker',
      select: 'fast',
      tools: { googleMaps: true },
      input: { text: 'x' },
    }).generation.geminiBucket,
    'planner',
  );
  assertEquals(
    resolveTurn({
      profile: 'picker',
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
    'portfolio',
  );
});

Deno.test('withGeminiKey stays on the free key when it succeeds', async () => {
  const used: string[] = [];
  const out = await withGeminiKey(
    'portfolio',
    (apiKey) => {
      used.push(apiKey);
      return Promise.resolve('ok');
    },
    { vault, wait: noWait },
  );
  assertEquals(out, 'ok');
  assertEquals(used, ['portfolio-key']);
});

Deno.test('withGeminiKey overflows to paid after quota backoff on a free bucket', async () => {
  const used: string[] = [];
  const out = await withGeminiKey(
    'studio',
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
  assertEquals(used, ['studio-key', 'studio-key', 'studio-key', 'paid-key']);
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
  const res = await fetchGemini(
    'https://example.com/v1',
    { method: 'POST', body: '{}' },
    'planner',
    {
      vault,
      wait: noWait,
      fetch: (_url, init) => {
        used.push(headerApiKey(init));
        return Promise.resolve(new Response('ok', { status: HTTP_OK }));
      },
    },
  );
  assertEquals(res.status, HTTP_OK);
  assertEquals(used, ['planner-key']);
});

Deno.test('fetchGemini overflows to paid after 429 backoff, not before', async () => {
  const used: string[] = [];
  const res = await fetchGemini(
    'https://example.com/v1?key=strip-me',
    { method: 'POST', body: '{}' },
    'portfolio',
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
  assertEquals(used, ['portfolio-key', 'portfolio-key', 'portfolio-key', 'paid-key']);
});

Deno.test('missing free key throws before any fetch', async () => {
  let threw = false;
  try {
    await fetchGemini('https://example.com/v1', {}, 'studio', {
      vault: { ...vault, studio: undefined },
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
  const res = await fetchGemini('https://example.com/v1/ping', { method: 'GET' }, 'portfolio', {
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
    'portfolio',
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
