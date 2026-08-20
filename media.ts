import { assertAttachmentLimits, requireMediaLimits } from './attachments.ts';
import { wrapUserData } from './boundary.ts';
import { CATALOG, geminiKindForMime, mimeAllowed, mimeEssence } from './catalog.ts';
import { TheorumError } from './error.ts';
import { synthesizeFixPrompt } from './fix.ts';
import type {
  BuiltinToolId,
  GeminiInputKind,
  ImageResponseFormat,
  InteractionPart,
  ModelId,
  Profile,
  TurnBlob,
  TurnRequest,
} from './types.ts';

function listedValue<T extends string>(
  allowed: readonly T[],
  requested: string | undefined,
): T | undefined {
  if (!requested) {
    return allowed[0];
  }
  for (const item of allowed) {
    if (item === requested) {
      return item;
    }
  }
  return undefined;
}

function requireImageSpec(profile: Profile, model: ModelId) {
  const spec = CATALOG.models[model].image;
  if (!spec) {
    throw new TheorumError(
      `Profile ${profile.id} requests media but ${model} is not an image model`,
    );
  }
  if (profile.outputs.structured !== null) {
    throw new TheorumError(
      `Profile ${profile.id} cannot mix structured JSON with native image output`,
    );
  }
  return spec;
}

function resolveImageFormat(
  profile: Profile,
  model: ModelId,
  slots?: Record<string, string>,
): ImageResponseFormat | null {
  if (!profile.outputs.media) {
    return null;
  }
  const spec = requireImageSpec(profile, model);
  const aspectRatio = listedValue(spec.aspectRatios, slots?.aspectRatio);
  const imageSize = listedValue(spec.sizes, slots?.imageSize);
  if (!(aspectRatio && imageSize)) {
    throw new TheorumError(`Unknown image aspect or size for ${profile.id}`);
  }
  return {
    type: 'image',
    mimeType: spec.outputMime,
    aspectRatio,
    imageSize,
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
  const accept = channel === 'voice' ? profile.inputs.voice?.accept : profile.inputs.attachments?.accept;
  if (!accept) {
    throw new TheorumError(`Profile ${profile.id} does not accept ${channel}`);
  }
  const spec = CATALOG.models[model].image;
  const imageCount = blobs.filter((blob) => geminiKindForMime(blob.mimeType) === 'image').length;
  if (spec && imageCount > spec.maxInputImages) {
    throw new TheorumError(`At most ${spec.maxInputImages} reference images on ${model}`);
  }
  return blobs.map((blob) => {
    const kind = assertGeminiMime(blob.mimeType);
    if (!mimeAllowed(accept, blob.mimeType)) {
      throw new TheorumError(`MIME '${blob.mimeType}' is not accepted on ${profile.id}`);
    }
    const essence = mimeEssence(blob.mimeType);
    if (kind === 'image' && spec && !spec.inputMimes.includes(essence) && essence !== 'image/jpg') {
      throw new TheorumError(`MIME '${blob.mimeType}' is not valid on ${model}`);
    }
    return { type: kind, mimeType: essence === 'image/jpg' ? 'image/jpeg' : essence, data: blob.data };
  });
}

function resolveInputParts(profile: Profile, model: ModelId, req: TurnRequest): InteractionPart[] {
  const parts: InteractionPart[] = [];
  const { text, attachments, voice, fix, history } = req.input;
  let promptText = text;
  if (fix) {
    promptText = synthesizeFixPrompt({ profile, fix, history });
  }
  if (promptText) {
    parts.push({ type: 'text', text: wrapUserData(promptText) });
  }
  const files = attachments ?? [];
  const clips = voice ?? [];
  if (files.length + clips.length > 0) {
    assertAttachmentLimits([...files, ...clips], requireMediaLimits(profile));
  }
  if (files.length > 0) {
    parts.push(...mediaParts(profile, model, files, 'attachments'));
  }
  if (clips.length > 0) {
    parts.push(...mediaParts(profile, model, clips, 'voice'));
  }
  return parts;
}

function assertImageGrounding(model: ModelId, builtins: BuiltinToolId[]): void {
  const spec = CATALOG.models[model].image;
  if (spec && !spec.allowsGrounding && builtins.length > 0) {
    throw new TheorumError(`Grounding tools are not valid on ${model}`);
  }
}

export { assertImageGrounding, resolveImageFormat, resolveInputParts };
