import assert from 'node:assert/strict';
import test from 'node:test';
import { entriesForFile, lintDocsTruth, normalizePath, pathRuleMatches } from './graph.mjs';

test('pathRuleMatches supports trailing slash and globs', () => {
  assert.equal(pathRuleMatches('src/kernel/', 'src/kernel/mod.ts'), true);
  assert.equal(pathRuleMatches('src/kernel/', 'src/providers/mod.ts'), false);
  assert.equal(pathRuleMatches('src/providers/*.ts', 'src/providers/mod.ts'), true);
  assert.equal(pathRuleMatches('src/**/stop.ts', 'src/kernel/stop.ts'), true);
});

test('providers owns openrouter adapter modules', async () => {
  const { default: graph } = await import('../../docs/_map.mjs');
  const openrouterOwners = entriesForFile(graph, normalizePath('src/providers/openrouter.ts'), {
    ownsOnly: true,
  });
  assert.deepEqual(
    openrouterOwners.map(([id]) => id),
    ['providers'],
  );

  const localOwners = entriesForFile(graph, normalizePath('src/providers/local.ts'), {
    ownsOnly: true,
  });
  assert.deepEqual(
    localOwners.map(([id]) => id),
    ['providers'],
  );
});

test('lint passes on current repo graph', async () => {
  const result = await lintDocsTruth({
    repoRoot: new URL('../..', import.meta.url).pathname,
    changedFiles: [],
  });
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
});
