# Google preset (`theorum/presets/google`)

Google / Gemini convenience pack: grounding builtins plus typed vocabularies
for image and speech-adjacent profile fields.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/presets/google` / `jsr:@theorum/core/presets/google` |
| Module | `src/presets/google.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/google.ts` | Google builtins + vocabularies |

## Builtins

`registerGooglePreset()` registers:

| Id | Notes |
| --- | --- |
| `googleSearch` | Interactions `google_search`; OpenRouter plugin `web` |
| `googleMaps` | Interactions `google_maps`; conflicts with `googleSearch` and `urlContext` |
| `urlContext` | Interactions `url_context` |

All are `kind: 'builtin'` with `ui: true`. Profiles must allowlist ids they use;
`conflictsWith` drops maps when search/urlContext are also requested.

## Vocabularies

Constants (and matching types) for host profile authoring:

| Constant | Purpose |
| --- | --- |
| `GOOGLE_IMAGE_INPUT_MIMES` | png / jpeg / webp / heic / heif |
| `GOOGLE_VOICE_INPUT_MIMES` | webm / wav / mpeg / mp4 |
| `GOOGLE_IMAGE_ASPECT_RATIOS` / `GOOGLE_IMAGE_SIZES` | Image output pins |
| `GOOGLE_SPEECH_VOICES` | TTS voice names for `outputs.speech.voice` |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageSize`, `GoogleVoiceInputMime` | Typed vocabulary unions |
| `GoogleImagePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins assignable to kernel specs |

Kernel types stay stringly; these packs make Google hosts typed when they opt in.

## Exported API

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register builtins into catalog |
| `GOOGLE_BUILTIN_TOOLS` | Static catalog entries |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_SIZES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Typed profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageSize`, `GoogleVoiceInputMime`, `GoogleImagePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins and vocabularies |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Builtins": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Vocabularies": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "source", "path": "src/presets/mod.ts" }
      ]
    }
  }
}
```
