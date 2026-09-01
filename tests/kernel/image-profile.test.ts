import '../fixtures/test-host.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { wrapUserData } from '../../src/kernel/engine/boundary.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/google/interactions.ts';
import { CHAT_MEDIA_LIMITS, modelAllow } from '../fixtures/models.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function* fakeComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: `${req.model}:${req.thinking}` };
  if (req.image) {
    yield {
      type: 'media',
      media: { mimeType: req.image.mimeType, data: 'image-bytes' },
    };
  }
}

const fake: ModelProvider = { complete: fakeComplete };

Deno.test('image oneshot uses image model and image response format', () => {
  const { generation } = resolveTurn({
    profile: 'image',
    input: {
      text: 'sleepy fox',
      attachments: [{ mimeType: 'image/png', data: 'ex' }],
      slots: { aspectRatio: '1:1' },
    },
  });
  assertEquals(generation.model, 'gemini31FlashLiteImage');
  assertEquals(generation.geminiBucket, 'paid');
  assertEquals(generation.thinking, 'minimal');
  assertEquals(generation.structured, null);
  assertEquals(generation.image, {
    type: 'image',
    mimeType: 'image/jpeg',
    aspectRatio: '1:1',
    size: '1K',
  });
  assertEquals(generation.input, [
    { type: 'text', text: wrapUserData('sleepy fox') },
    { type: 'image', mimeType: 'image/png', data: 'ex' },
  ]);
  assertEquals(generation.builtins, []);
});

Deno.test('image rejects too many reference images', () => {
  const images = Array.from({ length: CHAT_MEDIA_LIMITS.maxFiles + 1 }, () => ({
    mimeType: 'image/png',
    data: btoa('x'),
  }));
  assertThrows(
    () => resolveTurn({ profile: 'image', input: { text: 'x', attachments: images } }),
    TheorumError,
  );
});

Deno.test('image rejects mime the image model does not take', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'image',
        input: { text: 'x', attachments: [{ mimeType: 'image/gif', data: 'x' }] },
      }),
    TheorumError,
  );
});

Deno.test('image rejects unknown aspect ratio', () => {
  assertThrows(
    () => resolveTurn({ profile: 'image', input: { text: 'x', slots: { aspectRatio: '1:8' } } }),
    TheorumError,
  );
});

function googleImageBody() {
  const { generation } = resolveTurn({
    profile: 'image',
    input: { text: 'fox', attachments: [{ mimeType: 'image/jpeg', data: 'abc' }] },
  });
  return toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    geminiBucket: generation.geminiBucket,
  });
}

function assertImageWireBody(body: Record<string, unknown>): void {
  const turns = body.input as { type: string; content: Record<string, string>[] }[];
  const [turn] = turns;
  const [textPart, part] = turn.content;
  const format = body[camelToSnake('responseFormat')] as Record<string, string>;
  const mimeKey = camelToSnake('mimeType');
  assertEquals(body.model, 'gemini-3.1-flash-lite-image');
  assertEquals(body[camelToSnake('systemInstruction')], 'sys');
  assertEquals(turn.type, 'user_input');
  assertEquals(textPart, { type: 'text', text: wrapUserData('fox') });
  assertEquals(part.type, 'image');
  assertEquals(part.data, 'abc');
  assertEquals(part[mimeKey], 'image/jpeg');
  assertEquals(format.type, 'image');
  assertEquals(format[mimeKey], 'image/jpeg');
  assertEquals(format[camelToSnake('aspectRatio')], '1:1');
  assertEquals(format[camelToSnake('imageSize')], '1K');
}

Deno.test('interactions body places refs in input and image in response format', () => {
  assertImageWireBody(googleImageBody());
});

Deno.test('image runTurn yields media then done', async () => {
  const events = await collect(runTurn({ profile: 'image', input: { text: 'fox' } }, fake));
  assertEquals(
    events.map((e) => e.type),
    ['text', 'media', 'tokens', 'done'],
  );
  assertEquals(events[1]?.media?.mimeType, 'image/jpeg');
});

Deno.test('chat profile does not attach image response format', () => {
  const { generation } = resolveTurn({ profile: 'chat', input: { text: 'hi' } });
  assertEquals(generation.image, null);
  assertEquals(generation.input, [{ type: 'text', text: wrapUserData('hi') }]);
});

Deno.test('image projection exposes image pins not tools', () => {
  const ui = projectProfile('image');
  assertEquals(ui.tools, []);
  assertEquals(ui.outputs.image?.mimeType, 'image/jpeg');
  assertEquals(ui.image?.mimeType, 'image/jpeg');
  assertEquals(ui.image?.size, '1K');
  assertEquals(ui.image?.maxInputImages, 14);
  assertEquals(ui.controls, []);
});

Deno.test('media validations reject missing image pins, structured mixing, grounding on image, and invalid mime', async () => {
  const { registerProfile, defineProfile } = await import('../../src/kernel/registry/profiles.ts');

  // Image pins without aspect/size
  registerProfile(
    defineProfile({
      id: 'bad_media_profile',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      outputs: { structured: null, image: { mimeType: 'image/jpeg' } },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertThrows(
    () => resolveTurn({ profile: 'bad_media_profile', input: { text: 'test' } }),
    TheorumError,
  );

  // Image pins with structured output
  registerProfile(
    defineProfile({
      id: 'mixed_media_profile',
      model: { ...modelAllow('gemini31FlashLiteImage') },
      inputs: { text: true },
      outputs: {
        structured: 'custom',
        image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg' },
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertThrows(
    () => resolveTurn({ profile: 'mixed_media_profile', input: { text: 'test' } }),
    TheorumError,
  );

  // Grounding tool on image profile that disallows grounding
  registerProfile(
    defineProfile({
      id: 'image_with_search',
      model: { ...modelAllow('gemini31FlashLiteImage') },
      tools: { allow: ['googleSearch'] },
      inputs: { text: true },
      outputs: {
        structured: null,
        image: {
          aspectRatio: '1:1',
          size: '1K',
          mimeType: 'image/jpeg',
          allowsGrounding: false,
        },
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertThrows(
    () =>
      resolveTurn({
        profile: 'image_with_search',
        tools: { googleSearch: true },
        input: { text: 'search image' },
      }),
    TheorumError,
  );
});
