#!/usr/bin/env node
import { chmod, copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookSrc = path.join(repoRoot, 'scripts/hooks/pre-commit');
const hooksDir = path.join(repoRoot, '.git/hooks');
const hookDest = path.join(hooksDir, 'pre-commit');

try {
  await access(path.join(repoRoot, '.git'));
} catch {
  console.error('hooks:install: not a git repository');
  process.exit(1);
}

await mkdir(hooksDir, { recursive: true });
await copyFile(hookSrc, hookDest);
await chmod(hookDest, 0o755);
console.log('Installed pre-commit hook → npm run lint:docs');
