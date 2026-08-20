# Theorum Secrets & Keys Guide

This document details the environment variables required for running and testing Theorum both locally and in production.

---

## 1. Local Environment Setup

To prevent accidental git leaks, **keep your active `.env` file outside this repository**:

- **Recommended location**: `~/.config/theorum/.env`
- Alternatively, pass variables directly via your shell or execution environment.

To run scripts with the external env file:
```bash
deno run --allow-net --allow-env --allow-read --env-file=~/.config/theorum/.env scripts/verify-live.ts
```

---

## 2. Required Secrets

### `OPENROUTER_API_KEY`
- **Scope**: Required for the OpenRouter provider (`createOpenRouterProvider`). Unlocks access to all models hosted via OpenRouter (e.g. `google/gemini-2.5-flash`, `google/gemini-2.5-pro`, `anthropic/claude-3.5-sonnet`, `deepseek/deepseek-r1`, etc.).
- **Where to get it**: [https://openrouter.ai/keys](https://openrouter.ai/keys)
- **Permissions**: Read/Write API token with sufficient credit balance.

---

## 3. Optional Direct Provider Secrets

### `GEMINI_API_KEY`
- **Scope**: Used for direct Google Interactions API fallback and native Google SDK calls (`generate_image`, Google Maps grounding in `find_stores`).
- **Where to get it**: [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

### `CONCOURSE_PG_URL`
- **Scope**: Optional Postgres connection string for sinking agent traces into Postgres via `src/observability/trace-pg.ts`.
- **Default**: In local dev, traces sink to JSONL files or no-op if unset.
