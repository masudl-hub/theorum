import {
  CHAT_MEDIA_LIMITS,
  IMAGE_FLASH_LITE_ASPECT_RATIOS,
  IMAGE_FLASH_LITE_SIZES,
  IMAGE_INPUT_MIMES,
  VOICE_INPUT_MIMES,
} from '../../src/kernel/registry/catalog.ts';
import { registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerStructured } from '../../src/kernel/registry/schemas.ts';
import type { Profile } from '../../src/kernel/types.ts';

const CHAT_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/csv', 'text/plain'];
const FORMATTER_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/plain'];
const LONG_FLASH = 40_000;
const PIN_QUOTA = 4;
const CHAT_QUOTA = 10;
const FORMATTER_QUOTA = 20;

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' }, body: { type: 'string' } },
  required: ['message'],
};

registerStructured('chatTurn', { enforced: 'responseFormat', jsonSchema: MESSAGE_SCHEMA });
registerStructured('htmlTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, html: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('tsxTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, tsx: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('promptTurn', { enforced: 'prompt' });

const chat: Profile = {
  id: 'chat',
  identity: { handle: 'chat', system: 'Reply in the structured turn schema.' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    controls: ['thinking'],
    maxSteps: 1,
    key: 'freeA',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'chatTurn', media: false },
  guardrails: { quota: { perDay: CHAT_QUOTA } },
};

const pinned: Profile = {
  id: 'pinned',
  identity: { handle: 'pinned', chat: false, system: 'Keep replies short.' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    thinking: 'low',
    controls: [],
    maxSteps: 1,
    key: 'freeA',
  },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: 'chatTurn', media: false },
  guardrails: { quota: { perDay: PIN_QUOTA } },
};

const selector: Profile = {
  id: 'selector',
  identity: {
    handle: 'primary',
    systemByRole: { primary: 'You are Primary.', reviewer: 'You are Reviewer.' },
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini31ProPreview'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini31ProPreview' },
    thinking: { fast: 'low', smart: 'high' },
    override: {
      gemini35FlashLite: { maxOutputTokens: LONG_FLASH, summaries: 'auto' },
    },
    controls: [],
    maxSteps: 1,
    key: 'freeB',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'promptTurn', media: false },
  guardrails: { quota: { perDay: CHAT_QUOTA } },
};

const formatter: Profile = {
  id: 'formatter',
  identity: { handle: 'formatter', system: 'Produce source text in the structured turn schema.' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    controls: ['thinking'],
    maxSteps: 1,
    key: 'freeC',
  },
  tools: { allow: ['googleSearch', 'googleMaps'] },
  inputs: {
    text: true,
    attachments: { accept: FORMATTER_ATTACH },
    slots: { language: ['html', 'tsx'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: {
    structured: { by: 'language', map: { html: 'htmlTurn', tsx: 'tsxTurn' }, fallback: 'htmlTurn' },
    media: false,
  },
  guardrails: { quota: { perDay: FORMATTER_QUOTA } },
};

const image: Profile = {
  id: 'image',
  identity: { handle: 'image', system: 'Generate exactly one image.' },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini31FlashLiteImage'],
    thinking: 'minimal',
    controls: [],
    maxSteps: 1,
    key: 'freeA',
  },
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: IMAGE_INPUT_MIMES },
    slots: {
      aspectRatio: [...IMAGE_FLASH_LITE_ASPECT_RATIOS],
      imageSize: [...IMAGE_FLASH_LITE_SIZES],
    },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: null, media: true },
  guardrails: { quota: { perDay: PIN_QUOTA } },
};

registerProfile(chat);
registerProfile(pinned);
registerProfile(selector);
registerProfile(formatter);
registerProfile(image);
