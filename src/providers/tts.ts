/**
 * OpenRouter TTS provider utilities.
 *
 * Provides direct text-to-speech streaming and a `ModelProvider` wrapper for
 * voice output profiles.
 *
 * @module
 */

import { publicError } from '../guardrails/error.ts';
import type {
  InteractionPart,
  ModelProvider,
  OpenRouterAudioFormat,
  ProfileVoiceSpec,
  ProviderCompleteRequest,
  TurnEvent,
} from '../kernel/types.ts';
import { resolveOpenRouterApiKey } from './openrouter.ts';

const SAMPLE_RATE = 24000;
const TTS_MODEL = 'google/gemini-3.1-flash-tts-preview';
const HTTP_OK = 200;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Wrap raw PCM bytes in a RIFF/WAVE container. */
export function wrapPcmAsWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Host-supplied OpenRouter TTS configuration. */
export interface OpenRouterTtsConfig {
  apiKey?: string;
  voiceName?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
}

function extractInputText(input: InteractionPart[]): string {
  return input
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .trim();
}

function buildHeaders(apiKey: string, config: OpenRouterTtsConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }
  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }
  return headers;
}

function buildPayload(
  text: string,
  voiceSpec?: ProfileVoiceSpec,
  configVoiceName?: string,
): Record<string, unknown> {
  const voice = voiceSpec?.voice ?? configVoiceName;
  const responseFormat = voiceSpec?.responseFormat ?? 'pcm';
  const payload: Record<string, unknown> = {
    model: TTS_MODEL,
    input: text,
    response_format: responseFormat,
  };
  if (voice) {
    payload.voice = voice;
  }
  return payload;
}

async function requestTts(
  apiKey: string,
  text: string,
  req: ProviderCompleteRequest,
  config: OpenRouterTtsConfig,
): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
  const url = `${baseUrl}/audio/speech`;
  return await fetchFn(url, {
    method: 'POST',
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(buildPayload(text, req.voice, config.voiceName)),
  });
}

function* yieldTtsSuccess(
  rawBytes: Uint8Array,
  text: string,
  responseFormat: OpenRouterAudioFormat,
): Generator<TurnEvent> {
  let mediaMime = 'audio/mpeg';
  let mediaBytes = rawBytes;

  if (responseFormat === 'pcm') {
    mediaMime = 'audio/wav';
    mediaBytes = wrapPcmAsWav(rawBytes);
  }

  yield {
    type: 'media',
    media: { mimeType: mediaMime, data: bytesToBase64(mediaBytes) },
  };

  const inputTokens = Math.max(1, Math.round(text.length / 4));
  const outputTokens = Math.max(1, Math.round(rawBytes.length / 100));
  yield {
    type: 'tokens',
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
  };

  yield { type: 'done' };
}

/** Stream one OpenRouter TTS synthesis request as THEORUM events. */
export async function* streamOpenRouterTts(
  req: ProviderCompleteRequest,
  config: OpenRouterTtsConfig = {},
): AsyncGenerator<TurnEvent> {
  const apiKey = resolveOpenRouterApiKey(config.apiKey);
  if (!apiKey) {
    yield { type: 'error', error: publicError('missing OpenRouter API key for TTS') };
    return;
  }

  const text = extractInputText(req.input);
  if (!text) {
    yield { type: 'error', error: publicError('empty text for TTS') };
    return;
  }

  const res = await requestTts(apiKey, text, req, config);
  if (res.status !== HTTP_OK) {
    yield { type: 'error', error: publicError(`OpenRouter TTS HTTP ${String(res.status)}`) };
    return;
  }

  const arrayBuffer = await res.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuffer);
  if (rawBytes.length === 0) {
    yield { type: 'error', error: publicError('no audio returned from TTS') };
    return;
  }

  const responseFormat = req.voice?.responseFormat ?? 'pcm';
  for (const ev of yieldTtsSuccess(rawBytes, text, responseFormat)) {
    yield ev;
  }
}

/** Create a `ModelProvider` that emits TTS media events. */
export function createOpenRouterTtsProvider(config: OpenRouterTtsConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamOpenRouterTts(req, config),
  };
}
