import { build, emptyDir } from '@deno/dnt';

const outDir = './npm';
const version = JSON.parse(await Deno.readTextFile('./package.json')).version as string;

await emptyDir(outDir);

await build({
  entryPoints: [
    { name: '.', path: './mod.ts' },
    { name: './kernel', path: './src/kernel/mod.ts' },
    { name: './providers', path: './src/providers/mod.ts' },
    { name: './openrouter', path: './src/providers/openrouter-mod.ts' },
    { name: './guardrails', path: './src/guardrails/mod.ts' },
    { name: './observability', path: './src/observability/mod.ts' },
    { name: './host', path: './src/host/mod.ts' },
    { name: './cli', path: './src/cli/index.ts' },
    { name: './presets', path: './src/presets/mod.ts' },
    { name: './presets/google', path: './src/presets/google.ts' },
    { name: './streaming', path: './src/streaming/mod.ts' },
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
    repository: {
      type: 'git',
      url: 'https://github.com/masudl-hub/theorum',
    },
  },
  postBuild: async () => {
    await Deno.copyFile('README.md', `${outDir}/README.md`);
    await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);
    // Co-located contracts ship inside esm/src via the normal dnt copy of src/.
    // Also mirror them under docs/ for npm consumers who browse the tarball root.
    await Deno.mkdir(`${outDir}/docs`, { recursive: true });
    const contracts: Array<[string, string]> = [
      ['src/kernel/CONTRACT.md', 'docs/kernel.md'],
      ['src/providers/CONTRACT.md', 'docs/providers.md'],
      ['src/providers/OPENROUTER.md', 'docs/openrouter.md'],
      ['src/guardrails/CONTRACT.md', 'docs/guardrails.md'],
      ['src/observability/CONTRACT.md', 'docs/observability.md'],
      ['src/host/CONTRACT.md', 'docs/host.md'],
      ['src/cli/CONTRACT.md', 'docs/cli.md'],
      ['src/presets/CONTRACT.md', 'docs/presets.md'],
      ['src/presets/GOOGLE.md', 'docs/presets-google.md'],
      ['src/streaming/CONTRACT.md', 'docs/streaming.md'],
    ];
    for (const [from, to] of contracts) {
      await Deno.copyFile(from, `${outDir}/${to}`);
    }

    // npm publish rejects bin paths with a leading "./" and silently drops them.
    // dnt emits "./esm/...", so normalize before the package is packed.
    const pkgPath = `${outDir}/package.json`;
    const pkg = JSON.parse(await Deno.readTextFile(pkgPath)) as {
      bin?: Record<string, string> | string;
    };
    if (typeof pkg.bin === 'string') {
      pkg.bin = pkg.bin.replace(/^\.\//, '');
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const [name, target] of Object.entries(pkg.bin)) {
        pkg.bin[name] = target.replace(/^\.\//, '');
      }
    }
    await Deno.writeTextFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});
