# Theorum CLI & Testing Architecture Specification

## 1. Overview & Goals

The `theorum` CLI provides developer tooling, profile inspection, and stress-matrix synthesis for applications powered by Theorum.

### Core Objectives:
1. **Zero-Config Profile Stress Testing**: Automatically construct the most demanding valid payload (multimodal, deep reasoning, maximum tools) for any registered profile.
2. **Capability Matrix Permutations**: Systematically test or isolate specific capabilities (`--lite`, `--attachment`, `--voice`, `--map`, `--search`).
3. **Conflict Resolution**: Deterministically resolve provider conflicts (e.g. `search XOR maps`) and mutual exclusions without crashing.
4. **Host-Owned Execution**: The CLI never reads secrets or creates providers. Hosts supply providers when executing live tests programmatically.
5. **Interactive Turn REPL**: Execute ad-hoc runs only when the host has supplied a `ModelProvider`.

---

## 2. Command Surface & UX

```bash
theorum <command> [subcommand] [flags]
```

### 2.1 `theorum test` (Profile Verification & Stress Runner)

Builds validation turns against registered profiles. Live execution requires an explicit host-provided `ModelProvider`; Theorum does not read keys or create providers.

```bash
# 1. Stress Combo (Default): Auto-constructs the toughest valid test for this host profile
theorum test --profile your-profile

# 2. Lite (Smoke ping): Minimal prompt, fast mode, tools disabled
theorum test --profile your-profile --lite

# 3. Explicit capability flags: Override/test specific modalities
theorum test --profile your-profile --attachment ./reference.png --map --voice ./audio.wav

# 4. Full matrix test: Runs every permutation of supported tools/inputs for a profile
theorum test --profile your-profile --matrix

# 5. Global suite: Test all registered profiles
theorum test --all [--lite] [--concurrency 4]
```

#### CLI Flag Matrix:
| Flag | Type | Description |
| :--- | :--- | :--- |
| `--profile, -p` | `string` | Target profile ID registered by the host application |
| `--all, -a` | `boolean` | Run test across all registered profiles |
| `--lite` | `boolean` | Minimal single-turn connectivity ping (fast mode, tools off, text only) |
| `--matrix` | `boolean` | Generate and execute all valid permutations for the profile |
| `--attachment` | `string[]` | Path(s) to custom attachment files (PNG, PDF, CSV, etc.) |
| `--voice` | `string` | Path to custom voice input audio (WAV, PCM) |
| `--search` | `boolean` | Force Google Search tool on |
| `--map` | `boolean` | Force Google Maps tool on |
| `--mode` | `'fast' \| 'smart'` | Force reasoning / model speed tier |
| `--timeout` | `number` | Timeout in seconds (default: 30) |

---

### 2.2 `theorum run` (Terminal REPL & Ad-hoc Execution)

Interactive execution in the terminal with live streaming when called from a host that supplies a provider.

```bash
# Interactive REPL
theorum run --profile your-profile

# One-shot CLI run
theorum run --profile your-profile --prompt "Create a 3-tier architecture plan" --mode smart
```

---

### 2.3 `theorum profile` (Registry Inspection & Validation)

```bash
# List all registered profiles and supported modalities
theorum profile list

# Show detailed profile definition (inputs, tools, schema, model config)
theorum profile show your-profile

# Validate structured output schemas
theorum profile validate
```

---

## 3. Stress Matrix Synthesizer Logic

When `theorum test --profile <id>` is invoked without explicit flags, the synthesizer inspects `Profile` metadata:

```ts
interface SynthesizedTurn {
  profile: string;
  select?: 'fast' | 'smart';
  input: {
    text: string;
    voice?: AudioFixture;
    attachments?: AttachmentFixture[];
  };
  tools?: {
    googleSearch?: boolean;
    googleMaps?: boolean;
    codeExecution?: boolean;
    customTools?: string[];
  };
}
```

### Auto-Synthesis Rules:
1. **Model & Thinking Selection**:
   - If profile supports `smart` mode $\to$ select `smart` (highest pinned thinking tokens).
   - Otherwise $\to$ use default profile model.
2. **Multimodal Fixtures**:
   - If `inputs.voice` is set $\to$ inject synthetic 16kHz PCM/WAV voice-input fixture.
   - If `inputs.attachments === true` $\to$ inject synthetic test document/image matching allowed MIME types within byte ceilings (`maxBytes`).
3. **Tool Resolution & Conflict Handling**:
   - Turn on all allowed tools in `profile.tools.allow`.
   - **Mutual Exclusion Rule**: If both `googleSearch` and `googleMaps` are allowed, default to testing `googleSearch`. When `--matrix` is passed, split into two separate test runs (`[search]` and `[maps]`).
4. **Structured Schema Validation**:
   - If `profile.outputs.structured` is defined, validate that the final LLM response strictly parses against the JSON schema.

---

## 4. Fixture Management (`src/cli/matrix/fixtures.ts`)

Built-in zero-dependency synthetic fixtures:
- **`TEST_PNG`**: 1x1 valid PNG image byte buffer (`image/png`).
- **`TEST_PDF`**: Minimal valid PDF 1.4 document buffer (`application/pdf`).
- **`TEST_WAV`**: 1-second 16kHz mono PCM/WAV audio tone (`audio/wav`).
- **`TEST_CSV`**: Minimal CSV table data (`text/csv`).

---

## 5. File Structure in `theorum` Package

```
theorum/
├── docs/
│   ├── AGENT_PROFILE_CONTRACT.md
│   └── CLI_SPEC.md                      <-- This specification
├── src/
│   ├── cli/
│   │   ├── index.ts                     # CLI Entry point & router
│   │   ├── commands/
│   │   │   ├── test.ts                  # 'theorum test' execution & reporting
│   │   │   ├── run.ts                   # 'theorum run' REPL & SSE streaming
│   │   │   └── profile.ts               # 'theorum profile' inspector
│   │   └── matrix/
│   │       ├── fixtures.ts              # Built-in synthetic media fixtures
│   │       └── synthesizer.ts           # Matrix & stress combo generator
│   ├── guardrails/
│   ├── kernel/
│   └── observability/
├── deno.json                            # "tasks": { "theorum": "deno run -A src/cli/index.ts" }
└── mod.ts
```

---

## 6. Output & Reporting Contract

`theorum test` outputs concise terminal telemetry:

```
[THEORUM TEST] Profile: your-profile (smart mode)
------------------------------------------------------------
Inputs:      [Text, Voice (1s WAV), Attachment (1 PNG)]
Tools:       [googleSearch, codeExecution]
Provider:    host-supplied ModelProvider

⚡ Streaming Turn Execution:
  ✓ Thinking tokens: 1,420 tokens (1.12s)
  ✓ Tool dispatched: codeExecution (0.34s)
  ✓ Schema output: 852 tokens (0.78s)

Validation Checks:
  ✓ Security Canary: Intact & Redacted
  ✓ Schema Conformity: Valid (AST JSON)
  ✓ Latency: 2.24s total

STATUS: PASSED ✓
```
