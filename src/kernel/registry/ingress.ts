/**
 * Kernel ingress: input parts, image pins, and speech-role checks.
 *
 * Owned by the kernel so `resolveTurn` does not import provider adapters.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { wrapUserData } from '../engine/boundary.ts';
import { synthesizeRepairPrompt } from '../engine/repair.ts';
import type {
  BuiltinToolId,
  GeminiInputKind,
  ImageResponseFormat,
  InteractionPart,
  ModelId,
  Profile,
  TurnBlob,
  TurnRequest,
} from '../types.ts';
import { assertAttachmentLimits, requireMediaLimits } from './attachments.ts';
import { geminiKindForMime, mimeAllowed, mimeEssence } from './catalog.ts';

function listedValue(allowed: string[] | undefined, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!allowed || allowed.length === 0) {
    return value;
  }
  if (allowed.includes(value)) {
    return value;
  }
  return undefined;
}

function resolveSlotOrPin(
  profileId: string,
  label: string,
  slotValue: string | undefined,
  pin: string | undefined,
  allow: string[] | undefined,
): string | undefined {
  if (slotValue !== undefined) {
    const fromSlot = listedValue(allow, slotValue);
    if (!fromSlot) {
      throw new TheorumError(`Unknown image ${label} for ${profileId}`);
    }
    return fromSlot;
  }
  if (pin === undefined) {
    return undefined;
  }
  const fromPin = listedValue(allow, pin);
  if (!fromPin) {
    throw new TheorumError(`Unknown image ${label} for ${profileId}`);
  }
  return fromPin;
}

function assertImageRole(profile: Profile): NonNullable<Profile['outputs']['image']> {
  const pins = profile.outputs.image;
  if (!pins) {
    throw new TheorumError(
      `Profile ${profile.id} requests image output but does not set outputs.image`,
    );
  }
  assertExclusiveNativeOutput(profile, 'image');
  return pins;
}

function assertSpeechRole(profile: Profile): void {
  if (!profile.outputs.speech) {
    return;
  }
  assertExclusiveNativeOutput(profile, 'speech');
  if (profile.outputs.speech.format === 'mp3' && profile.model.protocol === 'geminiInteractions') {
    throw new TheorumError(
      `Profile ${profile.id}: outputs.speech.format 'mp3' requires protocol 'openAi' ` +
        `(geminiInteractions speech returns PCM and emits WAV)`,
    );
  }
}

function assertExclusiveNativeOutput(profile: Profile, kind: 'image' | 'speech'): void {
  const other = kind === 'image' ? 'speech' : 'image';
  if (profile.outputs[other]) {
    throw new TheorumError(
      `Profile ${profile.id} cannot mix outputs.${kind} with outputs.${other}`,
    );
  }
  if (profile.outputs.structured !== null && profile.outputs.structured !== undefined) {
    throw new TheorumError(
      `Profile ${profile.id} cannot mix structured JSON with native ${kind} output`,
    );
  }
}

function resolveImageFormat(
  profile: Profile,
  _model: ModelId,
  slots?: Record<string, string>,
): ImageResponseFormat | null {
  if (!profile.outputs.image) {
    return null;
  }
  const pins = assertImageRole(profile);
  const aspectRatio = resolveSlotOrPin(
    profile.id,
    'aspect',
    slots?.aspectRatio,
    pins.aspectRatio,
    profile.inputs.slots?.aspectRatio,
  );
  const size = resolveSlotOrPin(
    profile.id,
    'size',
    slots?.size,
    pins.size,
    profile.inputs.slots?.size,
  );
  if (!(aspectRatio && size)) {
    throw new TheorumError(`Unknown image aspect or size for ${profile.id}`);
  }
  return {
    type: 'image',
    mimeType: pins.mimeType ?? 'image/jpeg',
    aspectRatio,
    size,
  };
}

function assertGeminiMime(mime: string): GeminiInputKind {
  const kind = geminiKindForMime(mime);
  if (!kind) {
    throw new TheorumError(`MIME '${mime}' is not a Gemini input type`);
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
  const imageCount = blobs.filter((blob) => geminiKindForMime(blob.mimeType) === 'image').length;
  if (maxInputImages !== undefined && imageCount > maxInputImages) {
    throw new TheorumError(`At most ${maxInputImages} reference images on ${model}`);
  }
  return blobs.map((blob) => {
    const kind = assertGeminiMime(blob.mimeType);
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

function assertImageGrounding(profile: Profile, model: ModelId, builtins: BuiltinToolId[]): void {
  if (profile.outputs.image?.allowsGrounding === false && builtins.length > 0) {
    throw new TheorumError(`Grounding tools are not valid on ${model}`);
  }
}

export { assertImageGrounding, assertSpeechRole, resolveImageFormat, resolveInputParts };
