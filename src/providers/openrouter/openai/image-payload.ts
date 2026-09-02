/**
 * OpenAI-compatible image generation payloads.
 *
 * Maps kernel `ImageResponseFormat` pins to the `/images` REST body shared by
 * OpenRouter and other OpenAI-compat gateways.
 *
 * @module
 */

import type {
  ImageResponseFormat,
  InteractionMediaPart,
  InteractionPart,
  ProviderCompleteRequest,
} from '../../../kernel/types.ts';
import { exposeForTests } from '../../expose-for-tests.ts';

function extractPromptText(input: InteractionPart[]): string {
  return input
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

function outputFormatFromMime(mimeType: string): string {
  const essence = mimeType.toLowerCase().replace(/^image\//, '');
  if (essence === 'jpg') {
    return 'jpeg';
  }
  if (essence === 'png' || essence === 'jpeg' || essence === 'webp') {
    return essence;
  }
  return 'png';
}

function wireInputReference(part: InteractionMediaPart): Record<string, unknown> {
  return {
    type: 'image_url',
    image_url: { url: `data:${part.mimeType};base64,${part.data}` },
  };
}

function wireInputReferences(input: InteractionPart[]): Record<string, unknown>[] {
  const references: Record<string, unknown>[] = [];
  for (const part of input) {
    if (part.type === 'image') {
      references.push(wireInputReference(part));
    }
  }
  return references;
}

function attachImagePins(payload: Record<string, unknown>, image: ImageResponseFormat): void {
  payload.aspect_ratio = image.aspectRatio;
  payload.resolution = image.size;
  payload.output_format = outputFormatFromMime(image.mimeType);
}

/** Build a POST `/images` body for native image-generation models. */
function buildImagesPayload(req: ProviderCompleteRequest): Record<string, unknown> {
  if (!req.image) {
    throw new Error('buildImagesPayload requires req.image');
  }
  const payload: Record<string, unknown> = {
    model: req.apiId,
    prompt: extractPromptText(req.input),
  };
  attachImagePins(payload, req.image);
  const references = wireInputReferences(req.input);
  if (references.length > 0) {
    payload.input_references = references;
  }
  if (req.stream === false) {
    payload.stream = false;
  }
  return payload;
}

/** Tool parameters for gateways that generate images inside chat completions. */
function imageToolParameters(image: ImageResponseFormat): Record<string, unknown> {
  return {
    aspect_ratio: image.aspectRatio,
    resolution: image.size,
    output_format: outputFormatFromMime(image.mimeType),
  };
}

export { buildImagesPayload, extractPromptText, imageToolParameters };

exposeForTests('openai/image-payload', {
  extractPromptText,
  outputFormatFromMime,
  wireInputReference,
  wireInputReferences,
  attachImagePins,
  buildImagesPayload,
  imageToolParameters,
});
