/**
 * Untyped access to provider internals registered via exposeForTests().
 * Import ./enable-test-internals.ts before the provider module.
 *
 * Plain JS so the helper bag stays dynamically typed without `any` / suppressions
 * in TypeScript sources.
 */

export function testInternals(bucket) {
  const g = globalThis;
  const root = g.__theorumTestInternals;
  const api = root?.[bucket];
  if (!api || typeof api !== 'object') {
    throw new Error(
      `testInternals('${bucket}'): missing. Import enable-test-internals.ts before the provider module.`,
    );
  }
  return api;
}
