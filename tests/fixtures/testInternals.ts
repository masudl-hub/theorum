/**
 * Typed access to provider internals registered via exposeForTests().
 * Import ../fixtures/enable-test-internals.ts before the provider module.
 */

// deno-lint-ignore no-explicit-any
export function testInternals(bucket: string): any {
  const g = globalThis as Record<string, unknown>;
  const root = g.__theorumTestInternals as Record<string, unknown> | undefined;
  const api = root?.[bucket];
  if (!api || typeof api !== 'object') {
    throw new Error(
      `testInternals('${bucket}'): missing. Import enable-test-internals.ts before the provider module.`,
    );
  }
  return api;
}
