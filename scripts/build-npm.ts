import { build, emptyDir } from 'jsr:@deno/dnt@0.43.2';

const outDir = './npm';
const version = JSON.parse(await Deno.readTextFile('./package.json')).version as string;

await emptyDir(outDir);

await build({
  entryPoints: [
    { name: '.', path: './mod.ts' },
    { name: './kernel', path: './src/kernel/mod.ts' },
    { name: './providers', path: './src/providers/mod.ts' },
    { name: './openrouter', path: './src/providers/openrouter.ts' },
    { name: './guardrails', path: './src/guardrails/mod.ts' },
    { name: './observability', path: './src/observability/mod.ts' },
    { name: './host', path: './src/host/mod.ts' },
    { name: './cli', path: './src/cli/index.ts' },
    { name: './presets', path: './src/presets/mod.ts' },
    { name: './presets/google', path: './src/presets/google.ts' },
    {
      kind: 'bin',
      name: 'theorum',
      path: './src/cli/index.ts',
    },
  ],
  outDir,
  scriptModule: false,
  test: false,
  declaration: 'inline',
  shims: {
    deno: true,
  },
  compilerOptions: {
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    target: 'ES2022',
    strict: true,
  },
  package: {
    name: 'theorum',
    version,
    description:
      'A flat TypeScript agent kernel for typed profiles, deterministic turn execution, dynamic tools, provider adapters, guardrails, and host-injected traces.',
    license: 'MIT',
    type: 'module',
    keywords: [
      'agent',
      'ai',
      'kernel',
      'llm',
      'typescript',
      'deno',
      'node',
      'openrouter',
      'gemini',
    ],
    sideEffects: false,
  },
  postBuild: async () => {
    await Deno.copyFile('README.md', `${outDir}/README.md`);
    await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);
    await Deno.mkdir(`${outDir}/docs`, { recursive: true });
    await Deno.copyFile(
      'docs/AGENT_PROFILE_CONTRACT.md',
      `${outDir}/docs/AGENT_PROFILE_CONTRACT.md`,
    );
    await Deno.copyFile('docs/CLI_SPEC.md', `${outDir}/docs/CLI_SPEC.md`);
    await Deno.copyFile('docs/SECRETS.md', `${outDir}/docs/SECRETS.md`);
  },
});
