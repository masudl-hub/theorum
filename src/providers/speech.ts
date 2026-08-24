/**
 * Speech provider utilities (OpenRouter-compatible `/audio/speech`).
 *
 * Google speech uses Interactions via `createInteractionsProvider` /
 * `createProvider` when `protocol: 'geminiInteractions'` — not this module.
 * This module is the openAi/openrouter speech transport: model id + voice +
 * format → bytes → media events.
 *
 * @module
 */

import { publicError } from '../guardrails/error.ts';
import type {
  InteractionPart,
  ModelProvider,
  ProfileSpeechSpec,
  ProviderCompleteRequest,
  SpeechAudioFormat,
  TurnEvent,
} from '../kernel/types.ts';

const SAMPLE_RATE = 24000;
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

/** Host-supplied speech transport configuration. */
export interface SpeechProviderConfig {
  apiKey?: string;
  /** Fallback TTS voice when the profile does not pin `outputs.speech.voice`. */
  voice?: string;
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

/** Resolve provider-native speech model id from the complete request. */
function resolveSpeechWireModel(req: ProviderCompleteRequest): string {
  if (req.openRouterId) {
    return req.openRouterId;
  }
  if (req.apiId.includes('/')) {
    return req.apiId;
  }
  if (req.apiId) {
    return `google/${req.apiId}`;
  }
  return String(req.model);
}

function buildHeaders(apiKey: string, config: SpeechProviderConfig): Record<string, string> {
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
  req: ProviderCompleteRequest,
  text: string,
  speech: ProfileSpeechSpec | undefined,
  configVoice?: string,
): Record<string, unknown> {
  const voice = speech?.voice ?? configVoice;
  const format: SpeechAudioFormat = speech?.format ?? 'pcm';
  const payload: Record<string, unknown> = {
    model: resolveSpeechWireModel(req),
    input: text,
    response_format: format,
  };
  if (voice) {
    payload.voice = voice;
  }
  return payload;
}

async function requestSpeech(
  apiKey: string,
  text: string,
  req: ProviderCompleteRequest,
  config: SpeechProviderConfig,
): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
  const url = `${baseUrl}/audio/speech`;
  return await fetchFn(url, {
    method: 'POST',
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(buildPayload(req, text, req.speech, config.voice)),
  });
}

function* yieldSpeechSuccess(
  rawBytes: Uint8Array,
  text: string,
  format: SpeechAudioFormat,
): Generator<TurnEvent> {
  let mediaMime = 'audio/mpeg';
  let mediaBytes = rawBytes;

  if (format === 'pcm') {
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

/** Stream one speech synthesis request as THEORUM events. */
export async function* streamSpeech(
  req: ProviderCompleteRequest,
  config: SpeechProviderConfig = {},
): AsyncGenerator<TurnEvent> {
  const apiKey = config.apiKey?.trim() || undefined;
  if (!apiKey) {
    yield { type: 'error', error: publicError('missing API key for speech') };
    return;
  }

  const text = extractInputText(req.input);
  if (!text) {
    yield { type: 'error', error: publicError('empty text for speech') };
    return;
  }

  const res = await requestSpeech(apiKey, text, req, config);
  if (res.status !== HTTP_OK) {
    yield { type: 'error', error: publicError(`Speech HTTP ${String(res.status)}`) };
    return;
  }

  const arrayBuffer = await res.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuffer);
  if (rawBytes.length === 0) {
    yield { type: 'error', error: publicError('no audio returned from speech') };
    return;
  }

  const format = req.speech?.format ?? 'pcm';
  for (const ev of yieldSpeechSuccess(rawBytes, text, format)) {
    yield ev;
  }
}

/** Create a `ModelProvider` that emits speech media events. */
export function createSpeechProvider(config: SpeechProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamSpeech(req, config),
  };
}
