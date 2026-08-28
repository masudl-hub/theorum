/**
 * Fail fast before `deno publish` if local artifact trees or oversized files
 * could leak into the JSR tarball (especially with `--allow-dirty`).
 */
const root = new URL('..', import.meta.url).pathname;

/** Paths that must never ship; each must appear in deno.json publish.exclude. */
const ARTIFACT_DIRS = [
  '.stryker-cache',
  '.stryker-tmp',
  'coverage',
  'cov_profile',
  'traces',
  'npm',
  'node_modules',
  '.fallow',
  '.github',
  'tests',
  'scripts',
  'ast-grep-rules',
] as const;

const ARTIFACT_FILES = [
  'knip.json',
  'stryker.config.json',
  'stryker.log',
  '.fallowrc.jsonc',
  'biome.json',
  'sgconfig.yml',
  'package-lock.json',
] as const;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface DenoConfig {
  publish?: { exclude?: string[] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPublishExclude(): Promise<Set<string>> {
  const text = await Deno.readTextFile(`${root}/deno.json`);
  const config = JSON.parse(text) as DenoConfig;
  return new Set(config.publish?.exclude ?? []);
}

function normalizeExclude(entry: string): string {
  return entry.replace(/\/$/, '');
}

async function assertPublishExcludeCoversArtifacts(exclude: Set<string>): Promise<void> {
  const normalized = new Set([...exclude].map(normalizeExclude));
  const missing: string[] = [];

  for (const dir of ARTIFACT_DIRS) {
    const covered = [...normalized].some((e) => e === dir || e === `${dir}/`);
    if (!covered) missing.push(`${dir}/`);
  }
  for (const file of ARTIFACT_FILES) {
    if (!normalized.has(file)) missing.push(file);
  }

  if (missing.length > 0) {
    throw new Error(
      `deno.json publish.exclude is missing artifact paths:\n  ${missing.join('\n  ')}`,
    );
  }
}

async function findOversizedFiles(): Promise<string[]> {
  const hits: string[] = [];

  /** Artifact trees that may exist locally but must never contain huge blobs. */
  const sizeScanDirs = [
    '.stryker-cache',
    '.stryker-tmp',
    'coverage',
    'cov_profile',
    'traces',
    '.fallow',
  ] as const;

  for (const dir of sizeScanDirs) {
    const path = `${root}/${dir}`;
    if (!(await exists(path))) continue;
    for await (const file of walkFiles(path)) {
      const stat = await Deno.stat(file);
      if (stat.size > MAX_FILE_BYTES) hits.push(file);
    }
  }

  for await (const entry of Deno.readDir(root)) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (!entry.isFile) continue;
    const path = `${root}/${entry.name}`;
    const stat = await Deno.stat(path);
    if (stat.size > MAX_FILE_BYTES) hits.push(path);
  }

  return hits;
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === 'node_modules') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkFiles(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

async function main(): Promise<void> {
  const exclude = await readPublishExclude();
  await assertPublishExcludeCoversArtifacts(exclude);

  const oversized = await findOversizedFiles();
  if (oversized.length > 0) {
    const lines = oversized.map((p) => `  ${p.replace(root, '.')}`).join('\n');
    throw new Error(
      `Oversized files (> ${MAX_FILE_BYTES} bytes) must not exist before publish:\n${lines}`,
    );
  }

  console.log('verify-publish-bundle: exclude list covers artifacts; no oversized local files.');
}

await main();
