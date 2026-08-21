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
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    controls: ['thinking'],
    maxSteps: 1,
    key: 'portfolio',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'chatTurn', media: false, commit: 'diagram' },
  guardrails: { quota: { perDay: CHAT_QUOTA } },
};

const pinned: Profile = {
  id: 'pinned',
  identity: { handle: 'pinned', chat: false, system: 'Keep replies short.' },
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    thinking: 'low',
    controls: [],
    maxSteps: 1,
    key: 'portfolio',
  },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: 'chatTurn', media: false, commit: 'card' },
  guardrails: { quota: { perDay: PIN_QUOTA } },
};

const picker: Profile = {
  id: 'picker',
  identity: {
    handle: 'creator',
    systemByRole: { creator: 'You are Creator.', critic: 'You are Critic.' },
  },
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    thinking: { fast: 'low', smart: 'high' },
    override: {
      gemini35FlashLite: { maxOutputTokens: LONG_FLASH, summaries: 'auto' },
    },
    controls: [],
    maxSteps: 1,
    key: 'planner',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    slots: { handoff: ['creator', 'critic'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'promptTurn', media: false, commit: 'artifact' },
  guardrails: { quota: { perDay: CHAT_QUOTA } },
};

const designer: Profile = {
  id: 'designer',
  identity: { handle: 'designer', system: 'Produce UI source in the structured turn schema.' },
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    controls: ['thinking'],
    maxSteps: 1,
    key: 'studio',
  },
  tools: { allow: ['googleSearch', 'googleMaps'] },
  inputs: {
    text: true,
    attachments: { accept: DESIGNER_ATTACH },
    slots: { language: ['html', 'tsx'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: {
    structured: { by: 'language', map: { html: 'htmlTurn', tsx: 'tsxTurn' }, fallback: 'htmlTurn' },
    media: false,
    commit: 'artifact',
  },
  guardrails: { quota: { perDay: DESIGNER_QUOTA } },
};

const image: Profile = {
  id: 'image',
  identity: { handle: 'image', system: 'Generate exactly one image.' },
  model: {
    protocol: 'interactions',
    provider: 'google',
    allow: ['gemini31FlashLiteImage'],
    thinking: 'minimal',
    controls: [],
    maxSteps: 1,
    key: 'portfolio',
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
  outputs: { structured: null, media: true, commit: 'image' },
  guardrails: { quota: { perDay: PIN_QUOTA } },
};

registerProfile(chat);
registerProfile(pinned);
registerProfile(picker);
registerProfile(designer);
registerProfile(image);
