/**
 * Kernel ingress: input parts, image pins, and speech-role checks.
 *
 * Owned by the kernel so `resolveTurn` does not import provider adapters.
 *
 * @module
 */

import { wrapUserData } from '../../guardrails/canary.ts';
import { TheorumError } from '../../guardrails/error.ts';
import { synthesizeRepairPrompt } from '../engine/repair.ts';
import type {
  ImageResponseFormat,
  InteractionPart,
  MediaInputKind,
  ModelId,
  Profile,
  TurnBlob,
  TurnRequest,
} from '../types.ts';
import { assertAttachmentLimits, requireMediaLimits } from './attachments.ts';
import { mediaKindForMime, mimeAllowed, mimeEssence } from './catalog.ts';
import { getStructured } from './schemas.ts';

type PrimaryOutputMode = 'structured' | 'image' | 'speech';

function usesStructuredResponseFormat(structuredId: string | null): boolean {
  if (!structuredId) {
    return false;
  }
  const spec = getStructured(structuredId);
  return spec.enforced === 'responseFormat' && spec.jsonSchema != null;
}

function activePrimaryOutputModes(
  profile: Profile,
  structuredId: string | null,
): PrimaryOutputMode[] {
  const modes: PrimaryOutputMode[] = [];
  if (usesStructuredResponseFormat(structuredId)) {
    modes.push('structured');
  }
  if (profile.outputs.image) {
    modes.push('image');
  }
  if (profile.outputs.speech) {
    modes.push('speech');
  }
  return modes;
}

/**
 * Provider wire formats (JSON schema, image, speech) are mutually exclusive.
 * Prompt-enforced schemas and free text are not. Image profiles opt into
 * interleaved assistant text via `outputs.image.includeText`.
 */
function assertOutputMode(profile: Profile, structuredId: string | null): void {
  const active = activePrimaryOutputModes(profile, structuredId);
  if (active.length <= 1) {
    return;
  }
  throw new TheorumError(
    `Profile ${profile.id} declares multiple output wire formats (${active.join(', ')}). ` +
      `Only one of responseFormat JSON schema (outputs.structured with enforced ` +
      `'responseFormat'), image (outputs.image), or speech (outputs.speech) may be active. ` +
      `Prompt-enforced schemas and free text do not count toward this limit.`,
  );
}

function assertImageRole(profile: Profile): NonNullable<Profile['outputs']['image']> {
  const pins = profile.outputs.image;
  if (!pins) {
    throw new TheorumError(
      `Profile ${profile.id} requests image output but does not set outputs.image`,
    );
  }
  return pins;
}

function assertSpeechRole(profile: Profile): void {
  if (!profile.outputs.speech) {
    return;
  }
  if (profile.outputs.speech.format === 'mp3' && profile.model.protocol === 'geminiInteractions') {
    throw new TheorumError(
      `Profile ${profile.id}: outputs.speech.format 'mp3' requires protocol 'openAi' ` +
        `(geminiInteractions speech returns PCM and emits WAV)`,
    );
  }
}

function resolveImageFormat(profile: Profile): ImageResponseFormat | null {
  if (!profile.outputs.image) {
    return null;
  }
  const pins = assertImageRole(profile);
  return {
    type: 'image',
    mimeType: pins.mimeType ?? 'image/jpeg',
    aspectRatio: pins.aspectRatio,
    size: pins.size,
    includeText: pins.includeText === true,
  };
}

function assertMediaMime(mime: string): MediaInputKind {
  const kind = mediaKindForMime(mime);
  if (!kind) {
    throw new TheorumError(`MIME '${mime}' is not a supported media input type`);
  }
  return kind;
}

function mediaParts(
  profile: Profile,
  model: ModelId,
  blobs: TurnBlob[],
  channel: 'attachments' | 'voice',
): InteractionPart[] {
  const accept =
    channel === 'voice' ? profile.inputs.voice?.accept : profile.inputs.attachments?.accept;
  if (!accept) {
    throw new TheorumError(`Profile ${profile.id} does not accept ${channel}`);
  }
  const maxInputImages = profile.outputs.image?.maxInputImages;
  const imageCount = blobs.filter((blob) => mediaKindForMime(blob.mimeType) === 'image').length;
  if (maxInputImages !== undefined && imageCount > maxInputImages) {
    throw new TheorumError(`At most ${maxInputImages} reference images on ${model}`);
  }
  return blobs.map((blob) => {
    const kind = assertMediaMime(blob.mimeType);
    if (!mimeAllowed(accept, blob.mimeType)) {
      throw new TheorumError(`MIME '${blob.mimeType}' is not accepted on ${profile.id}`);
    }
    const essence = mimeEssence(blob.mimeType);
    return {
      type: kind,
      mimeType: essence === 'image/jpg' ? 'image/jpeg' : essence,
      data: blob.data,
    };
  });
}

function extractTextPart(profile: Profile, req: TurnRequest): InteractionPart | null {
  const { text, repair, history } = req.input ?? {};
  if (profile.inputs.text === false) {
    if (text) {
      throw new TheorumError(`Profile ${profile.id} does not accept text input`);
    }
    return null;
  }
  let promptText = text;
  if (repair) {
    promptText = synthesizeRepairPrompt({ profile, repair, history });
  }
  if (!promptText) {
    return null;
  }
  return { type: 'text', text: wrapUserData(promptText) };
}

function extractMediaParts(profile: Profile, model: ModelId, req: TurnRequest): InteractionPart[] {
  const { attachments, voice } = req.input ?? {};
  const files = attachments ?? [];
  const clips = voice ?? [];
  if (files.length + clips.length > 0) {
    assertAttachmentLimits([...files, ...clips], requireMediaLimits(profile));
  }
  const parts: InteractionPart[] = [];
  if (files.length > 0) {
    parts.push(...mediaParts(profile, model, files, 'attachments'));
  }
  if (clips.length > 0) {
    parts.push(...mediaParts(profile, model, clips, 'voice'));
  }
  return parts;
}

function resolveInputParts(profile: Profile, model: ModelId, req: TurnRequest): InteractionPart[] {
  const parts: InteractionPart[] = [];
  const textPart = extractTextPart(profile, req);
  if (textPart) {
    parts.push(textPart);
  }
  parts.push(...extractMediaParts(profile, model, req));
  return parts;
}

export { assertOutputMode, assertSpeechRole, resolveImageFormat, resolveInputParts };
