import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { eventsFromComplete, eventsFromDelta } from '../../src/kernel/engine/delta.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { createProvider } from '../../src/providers/create-provider.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/interactions.ts';
import type { GeminiVault } from '../../src/providers/keys.ts';
import { createInteractionsProvider } from '../../src/providers/provider.ts';
import { wrapPcmAsWav } from '../../src/providers/speech.ts';
import { HOST_MODELS } from '../fixtures/models.ts';

const vault: GeminiVault = {
  freeA: 'free-a-key',
  freeB: 'free-b-key',
  freeC: 'free-c-key',
  paid: 'paid-key',
};

function noWait(): Promise<void> {
  return Promise.resolve();
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function sseEvent(raw: string): unknown {
  return JSON.parse(raw);
}

function sseResponse(events: unknown[]): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n');
  return new Response(`${payload}\ndata: [DONE]\n`, { status: 200 });
}

Deno.test('speech profile resolves pins and model wire ids', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
  });
  assertEquals(generation.model, 'gemini31FlashTts');
  assertEquals(generation.apiId, 'gemini-3.1-flash-tts-preview');
  assertEquals(generation.speech, { voice: 'Kore', format: 'pcm' });
  assertEquals(generation.image, null);
  assertEquals(generation.structured, null);
});

Deno.test('Interactions body for speech uses audio response_format and speech_config', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Say hello' },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    openRouterId: generation.openRouterId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    geminiBucket: generation.geminiBucket,
  });

  const format = body[camelToSnake('responseFormat')] as Record<string, string>;
  const gen = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.1-flash-tts-preview');
  assertEquals(format.type, 'audio');
  assertEquals(gen[camelToSnake('speechConfig')], [{ voice: 'Kore' }]);
  assertEquals(gen[camelToSnake('thinkingLevel')], undefined);
  assertEquals(gen[camelToSnake('thinkingSummaries')], undefined);
});

Deno.test('delta extracts audio and output_audio media', () => {
  assertEquals(eventsFromDelta({ type: 'audio', mimeType: 'audio/pcm', data: 'abc' }), [
    { type: 'media', media: { mimeType: 'audio/pcm', data: 'abc' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'audio', data: 'raw' }), [
    { type: 'media', media: { mimeType: 'audio/pcm', data: 'raw' } },
  ]);

  const complete = eventsFromComplete(
    {
      event_type: 'interaction.complete',
      interaction: { output_audio: { data: 'pcmbytes' } },
    },
    false,
  );
  assertEquals(complete[0], {
    type: 'media',
    media: { mimeType: 'audio/pcm', data: 'pcmbytes' },
  });
});

Deno.test('Interactions speech turn wraps PCM as WAV media', async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const pcmB64 = btoa(String.fromCharCode(...pcm));
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'hi' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          sseEvent(
            `{"event_type":"interaction.complete","interaction":{"output_audio":{"data":"${pcmB64}"}}}`,
          ),
        ]),
      ),
  });

  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      openRouterId: generation.openRouterId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      speech: generation.speech,
      geminiBucket: generation.geminiBucket,
    }),
  );

  assertEquals(events[0]?.type, 'media');
  assertEquals(events[0]?.media?.mimeType, 'audio/wav');
  const expected = wrapPcmAsWav(pcm);
  assertEquals(events[0]?.media?.data, btoa(String.fromCharCode(...expected)));
});

Deno.test('createProvider routes google speech to Interactions', () => {
  const profile = getProfile('speech');
  const provider = createProvider(profile, {
    gemini: { vault, wait: noWait },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider requires gemini transport for Interactions', () => {
  assertThrows(() => createProvider(getProfile('speech'), {}), Error);
});

Deno.test('createProvider routes openrouter speech to speech transport', () => {
  registerProfile(
    defineProfile({
      id: 'or_speech',
      model: {
        protocol: 'openAi',
        provider: 'openrouter',
        allow: ['gemini31FlashTts'],
        config: { gemini31FlashTts: HOST_MODELS.gemini31FlashTts },
      },
      outputs: { speech: { voice: 'Orus', format: 'pcm' } },
    }),
  );
  const profile = getProfile('or_speech');
  const provider = createProvider(profile, { speech: { apiKey: 'k' } });
  assertEquals(typeof provider.complete, 'function');
});
