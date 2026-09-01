/** @type {import('../scripts/docs-truth/graph.mjs').DocsTruthGraph} */
const graph = {
  schema: 'theorum.docs-truth/v1',
  structural_sections: ['Export', 'Ownership', 'Exported API'],
  min_evidence_supports: 2,
  min_doc_lines: {
    default: 70,
    'README.md': 340,
    'docs/DOCS_TRUTH.md': 90,
    'docs/contracts/kernel.md': 280,
    'docs/contracts/providers.md': 160,
    'docs/contracts/guardrails.md': 110,
  },
  production_roots: [
    'mod.ts',
    'package.json',
    'src/',
    'scripts/docs-truth/',
  ],
  validation_roots: ['tests/', 'scripts/docs-truth/'],
  ignore: [
    'npm/',
    'node_modules/',
    'coverage/',
    'cov_profile/',
    'tmp/',
    '.fallow/',
  ],
  entries: {
    package: {
      export: '.',
      doc: 'README.md',
      owns: ['mod.ts', 'package.json'],
      watches: [
        {
          path: 'scripts/docs-truth/',
          reason: 'Docs-truth lint ships with the package repo',
          sections: ['Documentation'],
        },
        {
          path: 'docs/_map.mjs',
          reason: 'Ownership graph for docs-truth',
          sections: ['Documentation'],
        },
        {
          path: 'src/kernel/mod.ts',
          reason: 'README public entrypoints table tracks kernel surface',
          sections: ['Public Entrypoints'],
        },
        {
          path: 'src/providers/mod.ts',
          reason: 'README documents createProvider as the single door',
          sections: ['Public Entrypoints', 'Package Boundary'],
        },
      ],
      validates: ['tests/kernel/theorum.test.ts', 'scripts/docs-truth/graph.test.mjs'],
      required_sections: [
        'Core Principles',
        'Architecture',
        'Public Entrypoints',
        'Package Boundary',
        'Documentation',
      ],
    },

    'docs-truth': {
      export: '_internal/docs-truth',
      doc: 'docs/DOCS_TRUTH.md',
      owns: ['scripts/docs-truth/'],
      watches: [
        {
          path: 'docs/_map.mjs',
          reason: 'Graph manifest consumed by the linter',
          sections: ['Ownership', 'Rules'],
        },
      ],
      validates: ['scripts/docs-truth/graph.test.mjs'],
      required_sections: ['Export', 'Ownership', 'Rules', 'Package vs repo documentation', 'Production roots', 'CI and hooks'],
      section_triggers: [
        {
          paths: ['scripts/docs-truth/export-drift.mjs', 'scripts/docs-truth/graph.test.mjs'],
          sections: ['Rules'],
        },
        {
          paths: ['scripts/docs-truth/graph.mjs'],
          sections: ['Rules', 'Production roots'],
        },
        {
          paths: ['scripts/docs-truth/cli.mjs'],
          sections: ['CI and hooks'],
        },
        {
          paths: [
            'package.json',
            'deno.json',
            '.npmignore',
            'scripts/verify-publish-bundle.ts',
            'scripts/build-npm.ts',
          ],
          sections: ['Package vs repo documentation'],
        },
      ],
    },

    kernel: {
      export: './kernel',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/kernel/'],
      validates: [
        'tests/kernel/',
      ],
      required_sections: [
        'Export',
        'Ownership',
        'Profiles',
        'Turn lifecycle',
        'Stream events',
        'Dynamic tools',
        'Outputs and guardrails',
        'Compaction',
        'Stop and resume',
        'Validation',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/kernel/engine/compaction.ts', 'src/kernel/engine/history-tokens.ts'],
          sections: ['Compaction'],
        },
        {
          paths: ['src/kernel/stop.ts'],
          sections: ['Stop and resume'],
        },
        {
          paths: ['src/kernel/engine/runner/**', 'src/kernel/engine/runner.ts'],
          sections: ['Turn lifecycle'],
        },
        {
          paths: ['src/kernel/registry/profiles.ts', 'src/kernel/registry/resolve.ts', 'src/kernel/schema.ts'],
          sections: ['Profiles'],
        },
        {
          paths: ['src/kernel/registry/tools.ts', 'src/kernel/registry/catalog.ts', 'src/kernel/schema.ts'],
          sections: ['Dynamic tools'],
        },
      ],
    },

    providers: {
      export: './providers',
      doc: 'docs/contracts/providers.md',
      owns: ['src/providers/'],
      owns_except: ['src/providers/local/mod.ts'],
      watches: [
        {
          path: 'src/kernel/registry/vault.ts',
          reason: 'Gemini vault types feed createProvider',
          sections: ['Gemini transport', 'createProvider'],
        },
      ],
      validates: [
        'tests/providers/create-provider.test.ts',
        'tests/providers/create-provider-import-isolation.test.ts',
        'tests/providers/google/keys.test.ts',
        'tests/providers/google/interactions.test.ts',
        'tests/providers/google/google-interactions.test.ts',
        'tests/providers/google/speech-interactions.test.ts',
        'tests/providers/local/local.test.ts',
        'tests/providers/openrouter/chat.test.ts',
        'tests/providers/openrouter/speech.test.ts',
        'tests/providers/openrouter/openai/chat-payload.test.ts',
        'tests/providers/openrouter/openai/compat.test.ts',
        'tests/providers/openrouter/openai/sdk-messages.test.ts',
        'tests/providers/shared/pcm.test.ts',
        'tests/providers/shared/sse.test.ts',
        'tests/providers/shared/upstream-tape.test.ts',
        'tests/providers/shared/upstream-tap.test.ts',
      ],
      required_sections: [
        'Export',
        'Ownership',
        'Package boundary',
        'createProvider',
        'OpenRouter',
        'Google Interactions',
        'Local provider',
        'Speech roles',
        'Gemini transport',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/providers/create-provider.ts'],
          sections: ['createProvider', 'Package boundary'],
        },
        {
          paths: [
            'src/providers/openrouter/chat.ts',
            'src/providers/openrouter/openai/chat-payload.ts',
          ],
          sections: ['OpenRouter'],
        },
        {
          paths: ['src/providers/local/local.ts', 'src/providers/local/mod.ts'],
          sections: ['Local provider'],
        },
        {
          paths: [
            'src/providers/google/interactions.ts',
            'src/providers/google/google-interactions.ts',
          ],
          sections: ['Google Interactions'],
        },
        {
          paths: ['src/providers/openrouter/speech.ts'],
          sections: ['Speech roles'],
        },
      ],
    },

    'providers-local': {
      export: './providers/local',
      doc: 'docs/contracts/providers.md',
      owns: ['src/providers/local/mod.ts'],
      validates: ['tests/providers/local/local.test.ts'],
      required_sections: [
        'Export',
        'Local provider',
        'Exported API',
      ],
    },

    guardrails: {
      export: './guardrails',
      doc: 'docs/contracts/guardrails.md',
      owns: ['src/guardrails/'],
      validates: ['tests/guardrails/'],
      required_sections: [
        'Export',
        'Ownership',
        'Public errors',
        'Sanitization',
        'Injection categories (non-exhaustive)',
        'Sensitive data',
        'Quota',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/guardrails/error.ts'], sections: ['Public errors'] },
        { paths: ['src/guardrails/sanitize.ts', 'src/guardrails/injection.ts'], sections: ['Sanitization'] },
        { paths: ['src/guardrails/injection.ts'], sections: ['Injection categories (non-exhaustive)'] },
        { paths: ['src/guardrails/sensitive.ts'], sections: ['Sensitive data'] },
        { paths: ['src/guardrails/quota.ts'], sections: ['Quota'] },
      ],
    },

    observability: {
      export: './observability',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/'],
      validates: ['tests/observability/'],
      required_sections: [
        'Export',
        'Ownership',
        'Trace sinks',
        'Trace records',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/observability/trace.ts'], sections: ['Trace sinks'] },
        { paths: ['src/observability/trace-record.ts'], sections: ['Trace records'] },
      ],
    },

    host: {
      export: './host',
      doc: 'docs/contracts/host.md',
      owns: ['src/host/'],
      validates: ['tests/host/'],
      required_sections: [
        'Export',
        'Ownership',
        'HTTP replies',
        'Cutout mint trace',
        'Structured JSON preview',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/host/reply.ts'], sections: ['HTTP replies'] },
        { paths: ['src/host/mint-trace.ts'], sections: ['Cutout mint trace'] },
        {
          paths: ['src/host/readStreamingJsonStringField.ts'],
          sections: ['Structured JSON preview'],
        },
      ],
    },

    cli: {
      export: './cli',
      doc: 'docs/contracts/cli.md',
      owns: ['src/cli/'],
      validates: ['tests/cli/'],
      required_sections: [
        'Export',
        'Ownership',
        'Commands',
        'Matrix and fixtures',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/cli/commands/'], sections: ['Commands'] },
        { paths: ['src/cli/matrix/'], sections: ['Matrix and fixtures'] },
      ],
    },

    presets: {
      export: './presets',
      doc: 'docs/contracts/presets.md',
      owns: ['src/presets/mod.ts'],
      watches: [
        {
          path: 'src/presets/google.ts',
          reason: 'Presets barrel re-exports Google pack',
          sections: ['Exported API', 'Role in the package'],
        },
      ],
      validates: ['tests/kernel/theorum.test.ts'],
      required_sections: [
        'Export',
        'Ownership',
        'Role in the package',
        'When to use',
        'Exported API',
      ],
    },

    'presets-google': {
      export: './presets/google',
      doc: 'docs/contracts/presets-google.md',
      owns: ['src/presets/google.ts', 'src/presets/google/speech-voices.ts'],
      validates: ['tests/kernel/theorum.test.ts'],
      required_sections: [
        'Export',
        'Ownership',
        'Builtins',
        'Vocabularies',
        'Exported API',
      ],
    },
  },
};

export default graph;
