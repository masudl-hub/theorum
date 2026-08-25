/**
 * OpenAI-compatible `/audio/speech` transport (internal).
 *
 * Hosts use `createProvider(profile, { openRouter })` — this module is selected
 * when the profile is an openAi speech role. Not a separate public door.
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
import { wrapPcmAsWav } from './pcm.ts';

const HTTP_OK = 200;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Credentials for the openAi speech path (same shape as OpenRouter chat config + voice). */
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

async function* streamSpeech(
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

/** Internal ModelProvider for openAi speech roles. */
function createSpeechProvider(config: SpeechProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamSpeech(req, config),
  };
}

export { createSpeechProvider, streamSpeech };
