import {
  CHAT_MEDIA_LIMITS,
  IMAGE_FLASH_LITE_ASPECT_RATIOS,
  IMAGE_FLASH_LITE_SIZES,
  IMAGE_INPUT_MIMES,
  VOICE_INPUT_MIMES,
} from './catalog.ts';
import { registerProfile } from './profiles.ts';
import { registerStructured } from './schemas.ts';
import type { Profile } from './types.ts';

const CHAT_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/csv', 'text/plain'];
const DESIGNER_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/plain'];
const LONG_FLASH = 40_000;
const PIN_QUOTA = 4;
const CHAT_QUOTA = 10;
const DESIGNER_QUOTA = 20;

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
  protocol: 'interactions',
  maxSteps: 1,
  models: { allow: ['gemini35FlashLite'] },
  controls: ['thinking'],
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  key: 'portfolio',
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'chatTurn', media: false },
  commit: 'diagram',
  quota: { perDay: CHAT_QUOTA },
};

const pinned: Profile = {
  id: 'pinned',
  identity: { handle: 'pinned', chat: false, system: 'Keep replies short.' },
  protocol: 'interactions',
  maxSteps: 1,
  models: { allow: ['gemini35FlashLite'], thinking: 'low' },
  controls: [],
  tools: { allow: [] },
  key: 'portfolio',
  inputs: { text: true },
  outputs: { structured: 'chatTurn', media: false },
  commit: 'card',
  quota: { perDay: PIN_QUOTA },
};

const picker: Profile = {
  id: 'picker',
  identity: {
    handle: 'creator',
    systemByRole: { creator: 'You are Creator.', critic: 'You are Critic.' },
  },
  protocol: 'interactions',
  maxSteps: 1,
  models: {
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    thinking: { fast: 'low', smart: 'high' },
    override: {
      gemini35FlashLite: { maxOutputTokens: LONG_FLASH, summaries: 'auto' },
    },
  },
  controls: [],
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  key: 'planner',
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  slots: { handoff: ['creator', 'critic'] },
  outputs: { structured: 'promptTurn', media: false },
  commit: 'artifact',
  quota: { perDay: CHAT_QUOTA },
};

const designer: Profile = {
  id: 'designer',
  identity: { handle: 'designer', system: 'Produce UI source in the structured turn schema.' },
  protocol: 'interactions',
  maxSteps: 1,
  models: { allow: ['gemini35FlashLite'] },
  controls: ['thinking'],
  tools: { allow: ['googleSearch', 'googleMaps'] },
  key: 'studio',
  inputs: {
    text: true,
    attachments: { accept: DESIGNER_ATTACH },
    ...CHAT_MEDIA_LIMITS,
  },
  slots: { language: ['html', 'tsx'] },
  style: 'clientSwatches',
  outputs: {
    structured: { by: 'language', map: { html: 'htmlTurn', tsx: 'tsxTurn' }, fallback: 'htmlTurn' },
    media: false,
  },
  commit: 'artifact',
  quota: { perDay: DESIGNER_QUOTA },
};

const image: Profile = {
  id: 'image',
  identity: { handle: 'image', system: 'Generate exactly one image.' },
  protocol: 'interactions',
  maxSteps: 1,
  models: { allow: ['gemini31FlashLiteImage'], thinking: 'minimal' },
  controls: [],
  tools: { allow: [] },
  key: 'portfolio',
  inputs: {
    text: true,
    attachments: { accept: IMAGE_INPUT_MIMES },
    ...CHAT_MEDIA_LIMITS,
  },
  slots: {
    aspectRatio: [...IMAGE_FLASH_LITE_ASPECT_RATIOS],
    imageSize: [...IMAGE_FLASH_LITE_SIZES],
  },
  outputs: { structured: null, media: true },
  commit: 'image',
  quota: { perDay: PIN_QUOTA },
};

registerProfile(chat);
registerProfile(pinned);
registerProfile(picker);
registerProfile(designer);
registerProfile(image);
