import type { Profile } from '../types.ts';
import { CHAT_MEDIA_LIMITS, IMAGE_INPUT_MIMES, VOICE_INPUT_MIMES } from './catalog.ts';
import { registerProfile } from './profiles.ts';
import { registerStructured } from './schemas.ts';

const MERMAID_ATTACH = [
  ...IMAGE_INPUT_MIMES,
  'application/pdf',
  'text/csv',
  'text/plain',
  'text/markdown',
];
const STUDIO_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/plain'];
const PLANNER_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/csv', 'text/plain'];

// Schemas
registerStructured('mermaidTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      diagram: {
        type: 'object',
        properties: {
          mermaid: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['mermaid'],
      },
      transcript: { type: 'string' },
    },
    required: ['message'],
  },
});

registerStructured('studioHtmlTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, html: { type: 'string' } },
    required: ['message'],
  },
});

registerStructured('studioTsxTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, tsx: { type: 'string' } },
    required: ['message'],
  },
});

registerStructured('dailyFact', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      title: { type: 'string' },
      fact: { type: 'string' },
      takeaway: { type: 'string' },
    },
    required: ['message', 'title', 'fact'],
  },
});

registerStructured('dailyQuiz', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      answerIndex: { type: 'number' },
      explanation: { type: 'string' },
    },
    required: ['message', 'question', 'options', 'answerIndex'],
  },
});

registerStructured('dailyThought', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      thought: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['message', 'thought'],
  },
});

registerStructured('dailyInspiration', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      quote: { type: 'string' },
      author: { type: 'string' },
    },
    required: ['message', 'quote'],
  },
});

registerStructured('plannerTurn', { enforced: 'prompt' });
registerStructured('chatTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, body: { type: 'string' } },
    required: ['message'],
  },
});

// Profiles
export const mermaidProfile: Profile = {
  id: 'mermaid',
  identity: {
    handle: 'mermaid',
    chat: true,
    system:
      'You are a Mermaid diagram architect. Always emit valid Mermaid code in the structured turn.',
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    controls: ['thinking'],
    maxSteps: 1,
    key: 'portfolio',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: MERMAID_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
    maxFiles: 5,
  },
  outputs: { structured: 'mermaidTurn', media: false, commit: 'diagram' },
  guardrails: { quota: { perDay: 20 } },
};

export const studioProfile: Profile = {
  id: 'studio',
  identity: {
    handle: 'designer',
    system: 'Produce UI source in the structured turn schema. Chat in message only.',
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    controls: ['thinking'],
    maxSteps: 1,
    key: 'studio',
  },
  tools: { allow: ['googleSearch', 'googleMaps'] },
  inputs: {
    text: true,
    attachments: { accept: STUDIO_ATTACH },
    slots: { language: ['html', 'tsx'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: {
    structured: {
      by: 'language',
      map: { html: 'studioHtmlTurn', tsx: 'studioTsxTurn' },
      fallback: 'studioHtmlTurn',
    },
    media: false,
    commit: 'artifact',
  },
  guardrails: { quota: { perDay: 20 } },
};

export const plannerProfile: Profile = {
  id: 'planner',
  identity: {
    handle: 'creator',
    systemByRole: {
      creator: 'You are Creator. Emit planner JSON.',
      critic: 'You are Critic. Emit critique JSON.',
    },
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini37Flash'],
    select: { fast: 'gemini35FlashLite', smart: 'gemini37Flash' },
    thinking: { fast: 'low', smart: 'high' },
    override: {
      gemini35FlashLite: { maxOutputTokens: 40_000, summaries: 'auto' },
    },
    controls: [],
    maxSteps: 1,
    key: 'planner',
  },
  tools: { allow: ['googleSearch', 'googleMaps', 'urlContext'] },
  inputs: {
    text: true,
    attachments: { accept: PLANNER_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    slots: { handoff: ['creator', 'critic'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'plannerTurn', media: false, commit: 'artifact' },
  guardrails: { quota: { perDay: 10 } },
};

export const dailyProfile: Profile = {
  id: 'daily',
  identity: {
    handle: 'daily',
    chat: false,
    system:
      'You are a wholesome daily card writer. Warm, specific, never cheesy. Authenticity over hype.',
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite'],
    thinking: 'minimal',
    controls: [],
    maxSteps: 1,
    key: 'portfolio',
  },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: {
    structured: {
      by: 'contentType',
      map: {
        fact: 'dailyFact',
        quiz: 'dailyQuiz',
        thought: 'dailyThought',
        inspiration: 'dailyInspiration',
      },
      fallback: 'dailyFact',
    },
    media: false,
    commit: 'dailyCard',
  },
  guardrails: { quota: { perDay: 8 } },
};

export function registerBuiltinProfiles(): void {
  registerProfile(mermaidProfile);
  registerProfile(studioProfile);
  registerProfile(plannerProfile);
  registerProfile(dailyProfile);
}
