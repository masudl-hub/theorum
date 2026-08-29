/**
 * Side-channel for repo unit/mutation tests. Not part of the public package API
 * (not listed in package exports). Enabled only when THEORUM_TEST_INTERNALS=1.
 *
 * @module
 */

export function exposeForTests(bucket: string, api: Record<string, unknown>): void {
  let enabled = false;
  try {
    enabled = typeof Deno !== 'undefined' && Deno.env.get('THEORUM_TEST_INTERNALS') === '1';
  } catch {
    // Missing --allow-env, or non-Deno runtime: never expose.
  }
  if (!enabled) return;

  const g = globalThis as Record<string, unknown>;
  const root = (g.__theorumTestInternals ??= {}) as Record<string, unknown>;
  root[bucket] = api;
}
