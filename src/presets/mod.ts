/**
 * Optional THEORUM presets.
 *
 * Presets register host-convenience catalogs (provider builtins, media
 * vocabularies, later model packs) without baking product opinions into the kernel.
 *
 * @module
 */

export type {
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImagePins,
  GoogleImageSize,
  GoogleVoiceInputMime,
} from './google.ts';
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_VOICE_INPUT_MIMES,
  registerGooglePreset,
} from './google.ts';
