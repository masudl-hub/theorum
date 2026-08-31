#!/usr/bin/env node
import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookSrc = path.join(repoRoot, 'scripts/hooks/pre-commit');
const hooksDir = path.join(repoRoot, '.git/hooks');
const hookDest = path.join(hooksDir, 'pre-commit');

if (process.env.CI === 'true') {
  process.exit(0);
}

try {
  await access(path.join(repoRoot, '.git'));
} catch {
  process.exit(0);
}

await mkdir(hooksDir, { recursive: true });
await copyFile(hookSrc, hookDest);
await chmod(hookDest, 0o755);
console.log('Installed git pre-commit hook → npm run lint:docs (docs-truth, first step of npm run lint)');
