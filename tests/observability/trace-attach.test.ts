import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  loadedBetween,
  loadedModules,
  runImportProbe,
  stdoutBeforeMarker,
} from '../fixtures/run-import-probe.ts';

Deno.test('trace-attach has no eager google/interactions import', async () => {
  const src = await Deno.readTextFile(
    new URL('../../src/observability/trace-attach.ts', import.meta.url),
  );
  assertEquals(/from\s+['"].*google\/interactions\.ts['"]/.test(src), false);
  assertEquals(src.includes("import('../providers/google/interactions.ts')"), true);
});

Deno.test('trace-attach subprocess loads interactions wire only for geminiInteractions', async () => {
  const result = await runImportProbe('./probes/trace-attach-load.ts');
  if (result.code !== 0) {
    throw new Error(result.stderr || `probe exited ${result.code}`);
  }

  const beforeOpenAi = loadedModules(stdoutBeforeMarker(result.stdout, 'PHASE:openAi-record'));
  assertEquals(beforeOpenAi, []);

  const betweenRecords = loadedBetween(result.stdout, 'PHASE:openAi-record', 'PHASE:gemini-record');
  assertEquals(betweenRecords, ['google-interactions-wire']);

  const allLoaded = loadedModules(result.stdout);
  assertEquals(allLoaded, ['google-interactions-wire']);
  assertEquals(result.stdout.includes('PROBE_DONE'), true);
});
