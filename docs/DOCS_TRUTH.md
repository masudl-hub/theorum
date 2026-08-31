# Docs truth (`docs/_map.mjs`)

Deterministic document-health lint for THEORUM. No waivers. No LLM.

## Export

| Field | Value |
| --- | --- |
| CLI | `scripts/docs-truth/cli.mjs` (`lint`, `inventory`, `freshness`) |
| Export drift | `scripts/docs-truth/export-drift.mjs` |
| Graph | `docs/_map.mjs` |

## Ownership

| Path | Role |
| --- | --- |
| `scripts/docs-truth/graph.mjs` | Graph load, ownership, evidence, freshness |
| `scripts/docs-truth/cli.mjs` | `lint`, `inventory`, `freshness` |
| `scripts/docs-truth/export-drift.mjs` | Entrypoint export vs contract drift |
| `scripts/docs-truth/graph.test.mjs` | Contract tests |
| `docs/_map.mjs` | Export → doc ownership graph |

## Rules

| Rule | Behavior |
| --- | --- |
| Full ownership | Every production-root file has exactly one `owns` entry |
| Doc freshness | Changed code → owning doc appears in git diff |
| Section freshness | Watches/`section_triggers` → specific `##` headings must change |
| Owned fallback | Owned files → at least one behavioral section hunk |
| Evidence | ≥2 supports; behavioral sections require `contract_test` |
| Export drift | Entry `mod.ts` export names appear in owner contract |

## Production roots

| Root | Files |
| --- | --- |
| `mod.ts` | Package barrel |
| `package.json` | Published exports |
| `src/**/*.ts` | Kernel + adapters |
| `scripts/docs-truth/**/*.mjs` | Docs-truth linter |

## CI and hooks

- CI: `npm run lint:docs` with `THEORUM_DOCS_BASE=origin/<base>`
- Local: `npm run hooks:install` installs pre-commit → `lint:docs`

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/cli.mjs" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/graph.mjs" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Rules": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/graph.mjs" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    },
    "Production roots": {
      "supports": [
        { "kind": "graph", "path": "docs/_map.mjs" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    },
    "CI and hooks": {
      "supports": [
        { "kind": "config", "path": "package.json" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    }
  }
}
```
