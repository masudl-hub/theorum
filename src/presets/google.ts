/**
 * Google / Gemini convenience preset.
 *
 * Kernel stays open (`string` pins). This pack owns Google vocabularies as
 * real unions so host profiles stay typed when they opt into the preset.
 *
 * Call `registerGooglePreset()` at host startup for tools; use the exported
 * types/constants when authoring image/speech-adjacent profile fields.
 *
 * @module
 */

import { registerTools } from '../kernel/registry/catalog.ts';
import type { ProfileImageSpec, ProfileSpeechSpec, ToolCatalogEntry } from '../kernel/types.ts';
import { GOOGLE_SPEECH_VOICES, type GoogleSpeechVoice } from './google/speech-voices.ts';

/** Google Interactions / Gemini grounding builtins. */
const GOOGLE_BUILTIN_TOOLS: Record<string, ToolCatalogEntry> = {
  googleSearch: {
    kind: 'builtin',
    ui: true,
    interactionsType: 'google_search',
    openRouterPlugin: 'web',
  },
  googleMaps: {
    kind: 'builtin',
    ui: true,
    interactionsType: 'google_maps',
    conflictsWith: ['googleSearch', 'urlContext'],
  },
  urlContext: {
    kind: 'builtin',
    ui: true,
    interactionsType: 'url_context',
  },
  codeExecution: {
    kind: 'builtin',
    ui: true,
    interactionsType: 'code_execution',
  },
};

/** Common Gemini image input MIME allowlist. */
const GOOGLE_IMAGE_INPUT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** Common voice/audio input MIME allowlist for Gemini multimodal. */
const GOOGLE_VOICE_INPUT_MIMES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'] as const;

/**
 * `outputs.speech` pins narrowed to Google TTS vocabulary.
 * Assignable to kernel `ProfileSpeechSpec`.
 */
type GoogleSpeechPins = Omit<ProfileSpeechSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

/** Aspect ratios commonly accepted by Gemini image models. */
const GOOGLE_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

/** Image sizes commonly accepted by Gemini Flash Lite image. */
const GOOGLE_IMAGE_SIZES = ['1K'] as const;

type GoogleImageInputMime = (typeof GOOGLE_IMAGE_INPUT_MIMES)[number];
type GoogleVoiceInputMime = (typeof GOOGLE_VOICE_INPUT_MIMES)[number];
type GoogleImageAspectRatio = (typeof GOOGLE_IMAGE_ASPECT_RATIOS)[number];
type GoogleImageSize = (typeof GOOGLE_IMAGE_SIZES)[number];

/**
 * `outputs.image` pins narrowed to Google image vocabulary.
 * Assignable to kernel `ProfileImageSpec`.
 */
type GoogleImagePins = Omit<ProfileImageSpec, 'aspectRatio' | 'size' | 'mimeType'> & {
  aspectRatio?: GoogleImageAspectRatio;
  size?: GoogleImageSize;
  mimeType?: GoogleImageInputMime | 'image/jpeg';
};

/** Register Google provider builtins into the process-local tool catalog. */
function registerGooglePreset(): void {
  registerTools(GOOGLE_BUILTIN_TOOLS);
}

export type {
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImagePins,
  GoogleImageSize,
  GoogleSpeechPins,
  GoogleSpeechVoice,
  GoogleVoiceInputMime,
};
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_VOICE_INPUT_MIMES,
  registerGooglePreset,
};
