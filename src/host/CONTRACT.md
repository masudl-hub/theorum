# Host (`theorum/host`)

Optional Deno HTTP helpers for host applications. **Not** part of the turn
kernel — import only when you want shared reply/status glue and cutout-trace
flushing without reimplementing it per route.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/host` / `jsr:@theorum/core/host` |
| Module | `src/host/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/host/reply.ts` | JSON responses + HTTP status constants |
| `src/host/mint-trace.ts` | Cutout mint trace flush helpers |
| `src/host/mod.ts` | Public barrel |

## HTTP replies

| Export | Role |
| --- | --- |
| `json(status, body, cors)` | JSON `Response` with merged CORS headers |
| `caughtStatus(err)` | `400` for `TheorumError`, else `500` |
| `HTTP_OK` | `200` |
| `HTTP_BUSY` | `429` |
| `HTTP_NOT_FOUND` | `404` |
| `HTTP_METHOD` | `405` |

Example:

```ts
import { caughtStatus, HTTP_BUSY, json } from "theorum/host";

try {
  return json(200, { ok: true }, cors);
} catch (err) {
  return json(caughtStatus(err), { error: publicError(err) }, cors);
}
```

Quota busy responses typically use `HTTP_BUSY` after `takeSlot` returns `busy`.

## Cutout mint trace

| Export | Role |
| --- | --- |
| `flushMintTrace` | Flush pending cutout mint records after a turn |
| `CutoutTape` | Tape type for mint/cutout correlation |

Use when your Deno HTTP host records mint/cutout telemetry alongside THEORUM
turns. Skip entirely for non-HTTP or non-Deno hosts.

## Exported API

Live list: `src/host/mod.ts` (`json`, status constants, `caughtStatus`,
`flushMintTrace`, `CutoutTape`).

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "HTTP replies": {
      "supports": [
        { "kind": "source", "path": "src/host/reply.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    },
    "Cutout mint trace": {
      "supports": [
        { "kind": "source", "path": "src/host/mint-trace.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    }
  }
}
```
