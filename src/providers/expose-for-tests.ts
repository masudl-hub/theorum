/**
 * Side-channel for repo unit/mutation tests. Not part of the public package API
 * (not listed in package exports). Enabled only when THEORUM_TEST_INTERNALS=1.
 *
 * @module
 */

/** Subprocess import-isolation probes (`THEORUM_IMPORT_PROBE=1`) log `LOADED:<label>`. */
export function markModuleLoad(label: string): void {
  try {
    const d = (globalThis as Record<string, unknown>).Deno as
      | {
          env?: { get(key: string): string | undefined };
          stdout?: { writeSync(data: Uint8Array): void };
        }
      | undefined;
    if (d?.env?.get('THEORUM_IMPORT_PROBE') === '1' && d.stdout?.writeSync) {
      d.stdout.writeSync(new TextEncoder().encode(`LOADED:${label}\n`));
    }
  } catch {
    // Non-Deno runtime or missing --allow-env.
  }
}

export function exposeForTests(bucket: string, api: Record<string, unknown>): void {
  let enabled = false;
  try {
    enabled = typeof Deno !== 'undefined' && Deno.env.get('THEORUM_TEST_INTERNALS') === '1';
  } catch {
    // Missing --allow-env, or non-Deno runtime: never expose.
  }
  if (!enabled) return;

  const g = globalThis as Record<string, unknown>;
  let root = g.__theorumTestInternals as Record<string, unknown> | undefined;
  if (!root) {
    root = {};
    g.__theorumTestInternals = root;
  }
  root[bucket] = api;
}
