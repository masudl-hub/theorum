import './test-host.ts';
import { assertEquals, assertThrows } from './assert.ts';
import { CATALOG, clampThinkingLevel } from './catalog.ts';
import { PUBLIC_ACTION, TheorumError } from './error.ts';
import { getProfile } from './profiles.ts';
import { projectProfile, resolveTurn } from './resolve.ts';
import { runTurn } from './runner.ts';
import { executeTool } from './tools.ts';
import type {
  CustomToolId,
  ModelProvider,
  ProfileId,
  ProviderCompleteRequest,
  TurnEvent,
} from './types.ts';

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
  if (req.structured) {
    yield { type: 'structured', structured: { schema: req.structured } };
  }
  if (req.image) {
    yield {
      type: 'media',
      media: { mimeType: req.image.mimeType, data: 'vinyl-bytes' },
    };
  }
}

const fake: ModelProvider = { complete: fakeComplete };

const LONG_FLASH = 40_000;

function withTools(id: ProfileId, extra: CustomToolId[]) {
  const profile = getProfile(id);
  return { ...profile, tools: { allow: [...profile.tools.allow, ...extra] } };
}

Deno.test('every profile is oneshot', () => {
  const ids: ProfileId[] = ['chat', 'pinned', 'designer', 'picker', 'image'];
  for (const id of ids) {
    assertEquals(getProfile(id).maxSteps, 1);
  }
});

Deno.test('flash lite thinking off is minimal', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    thinking: false,
    input: { text: 'hi' },
  });
  assertEquals(generation.model, 'gemini35FlashLite');
  assertEquals(generation.thinking, 'minimal');
  assertEquals(generation.summaries, 'none');
  assertEquals(CATALOG.models.gemini35FlashLite.thinking.off, 'minimal');
});

Deno.test('thinking level shapes differ by model family', () => {
  assertEquals(CATALOG.models.gemini31FlashLite.thinkingLevels, [
    'minimal',
    'low',
    'medium',
    'high',
  ]);
  assertEquals(CATALOG.models.gemini35FlashLite.thinkingLevels, [
    'minimal',
    'low',
    'medium',
    'high',
  ]);
  assertEquals(CATALOG.models.gemini37Flash.thinkingLevels, ['low', 'medium', 'high']);
  assertEquals(CATALOG.models.gemini31FlashLiteImage.thinkingLevels, ['minimal', 'high']);
  assertEquals(CATALOG.models.gemini37Flash.thinking.off, 'low');
  assertEquals(clampThinkingLevel('gemini37Flash', 'minimal'), 'low');
  assertEquals(clampThinkingLevel('gemini31FlashLite', 'minimal'), 'minimal');
});

Deno.test('flash lite thinking on is high', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    thinking: true,
    input: { text: 'hi' },
  });
  assertEquals(generation.thinking, 'high');
  assertEquals(generation.summaries, 'auto');
});

Deno.test('daily pins thinking low without a control', () => {
  const { generation } = resolveTurn({ profile: 'pinned', input: {} });
  assertEquals(generation.thinking, 'low');
  assertEquals(projectProfile('pinned').controls, []);
});

Deno.test('planner fast/smart pick model and pinned thinking', () => {
  const fast = resolveTurn({ profile: 'picker', select: 'fast', input: { text: 'x' } });
  assertEquals(fast.generation.model, 'gemini35FlashLite');
  assertEquals(fast.generation.thinking, 'low');
  assertEquals(fast.generation.maxOutputTokens, LONG_FLASH);
  const smart = resolveTurn({ profile: 'picker', select: 'smart', input: { text: 'x' } });
  assertEquals(smart.generation.model, 'gemini37Flash');
  assertEquals(smart.generation.thinking, 'high');
});

Deno.test('search xor maps drops maps', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    tools: { googleSearch: true, googleMaps: true },
    input: { text: 'x' },
  });
  assertEquals(generation.builtins, ['googleSearch']);
});

Deno.test('studio cannot enable urlContext', () => {
  const { generation } = resolveTurn({
    profile: 'designer',
    tools: { urlContext: true, googleSearch: true },
    input: { text: 'x' },
  });
  assertEquals(generation.builtins, ['googleSearch']);
});

Deno.test('tools stay off until the turn gates them', () => {
  const idle = resolveTurn({ profile: 'chat', input: { text: 'x' } });
  assertEquals(idle.generation.builtins, []);
  assertEquals(idle.generation.custom, []);
  const search = resolveTurn({
    profile: 'chat',
    tools: { googleSearch: true, askUser: true },
    input: { text: 'x' },
  });
  assertEquals(search.generation.builtins, ['googleSearch']);
  assertEquals(search.generation.custom, []);
});

Deno.test('studio language slot picks structured schema', () => {
  const html = resolveTurn({
    profile: 'designer',
    input: { text: 'x', slots: { language: 'html' } },
  });
  assertEquals(html.generation.structured, 'htmlTurn');
  const tsx = resolveTurn({
    profile: 'designer',
    input: { text: 'x', slots: { language: 'tsx' } },
  });
  assertEquals(tsx.generation.structured, 'tsxTurn');
});

Deno.test('handoff target is a profile slot', () => {
  const planner = withTools('picker', ['handoff']);
  executeTool(planner, 'handoff', { to: 'critic' });
  assertThrows(() => executeTool(planner, 'handoff', { to: 'mermaid' }), TheorumError);
});

Deno.test('disallowed tool cannot run', () => {
  assertThrows(
    () => executeTool(getProfile('pinned'), 'askUser', { kind: 'text', prompt: 'q' }),
    TheorumError,
  );
});

Deno.test('askUser pauses when allowed', () => {
  const env = executeTool(withTools('chat', ['askUser']), 'askUser', {
    kind: 'text',
    prompt: 'which?',
  });
  assertEquals(env.status, 'pause');
});

Deno.test('ui invoke askUser on mermaid is denied until allowed', async () => {
  const events = await collect(
    runTurn(
      {
        profile: 'chat',
        input: { text: 'x' },
        toolInvoke: { name: 'askUser', arguments: { kind: 'text', prompt: 'q' } },
      },
      fake,
    ),
  );
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
});

Deno.test('runTurn oneshot yields text structured done', async () => {
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'flow' } }, fake));
  assertEquals(
    events.map((e) => e.type),
    ['text', 'structured', 'tokens', 'done'],
  );
});

Deno.test('projection lists only allowed tools', () => {
  const ui = projectProfile('designer');
  assertEquals(
    ui.tools.map((t) => t.name),
    ['googleSearch', 'googleMaps'],
  );
  assertEquals(ui.controls, ['thinking']);
  assertEquals(ui.inputs.voice, undefined);
});

Deno.test('unknown planner select is rejected', () => {
  assertThrows(
    () => resolveTurn({ profile: 'picker', select: 'turbo', input: { text: 'x' } }),
    TheorumError,
  );
});

Deno.test('askUser validates kind and prompt', () => {
  const profile = withTools('chat', ['askUser']);
  assertEquals(executeTool(profile, 'askUser', { kind: 'nope', prompt: 'q' }).status, 'error');
  assertEquals(executeTool(profile, 'askUser', { kind: 'text', prompt: '  ' }).status, 'error');
});

Deno.test('generateMedia is unwired and other custom tools stub', () => {
  assertEquals(
    executeTool(withTools('chat', ['generateMedia']), 'generateMedia', {}).status,
    'error',
  );
  assertEquals(executeTool(withTools('chat', ['validate']), 'validate', { n: 1 }).status, 'ok');
});

Deno.test('handoff requires a string target', () => {
  const planner = withTools('picker', ['handoff']);
  assertEquals(executeTool(planner, 'handoff', { to: 1 }).status, 'error');
});

Deno.test('provider tool call is dispatched', async () => {
  async function* complete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield {
      type: 'tool',
      tool: { name: 'askUser', arguments: { kind: 'text', prompt: 'q' } },
    };
  }
  const provider: ModelProvider = { complete };
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'flow' } }, provider));
  assertEquals(
    events.some((e) => e.type === 'error' && e.error === PUBLIC_ACTION),
    true,
  );
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('planner critic role still completes', async () => {
  const events = await collect(
    runTurn({ profile: 'picker', select: 'fast', input: { text: 'plan', role: 'critic' } }, fake),
  );
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
});

Deno.test('empty mermaid input still runs', async () => {
  const events = await collect(runTurn({ profile: 'chat', input: {} }, fake));
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('chat voice audio becomes an audio interaction part', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      voice: [{ mimeType: 'audio/webm;codecs=opus', data: 'dGVzdA==' }],
    },
  });
  const audio = generation.input.find((part) => part.type === 'audio');
  assertEquals(audio?.type, 'audio');
  if (audio?.type === 'audio') {
    assertEquals(audio.mimeType, 'audio/webm');
  }
});

Deno.test('chat pdf attachment becomes a document part', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      attachments: [{ mimeType: 'application/pdf', data: 'dGVzdA==' }],
    },
  });
  const doc = generation.input.find((part) => part.type === 'document');
  assertEquals(doc?.type, 'document');
});

Deno.test('chat rejects video because the profile does not allow it', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: { text: 'hi', attachments: [{ mimeType: 'video/mp4', data: 'dGVzdA==' }] },
      }),
    TheorumError,
  );
});

Deno.test('chat rejects audio on the attachments channel', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: { text: 'hi', attachments: [{ mimeType: 'audio/webm', data: 'dGVzdA==' }] },
      }),
    TheorumError,
  );
});

Deno.test('pinned does not accept voice', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'pinned',
        input: { voice: [{ mimeType: 'audio/webm', data: 'dGVzdA==' }] },
      }),
    TheorumError,
  );
});

import { synthesizeFixPrompt } from './fix.ts';
import { registerProfile } from './profiles.ts';

Deno.test('synthesizeFixPrompt scopes history to last 2 exchanges and includes error/artifact', () => {
  const prompt = synthesizeFixPrompt({
    profile: getProfile('chat'),
    fix: { artifact: 'graph TD\nA-->B', error: 'syntax error on line 2', guidance: 'Use valid Mermaid' },
    history: [
      { role: 'user', content: 'msg 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'msg 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'msg 3' },
      { role: 'assistant', content: 'reply 3' },
    ],
  });
  assertEquals(prompt.includes('msg 1'), false);
  assertEquals(prompt.includes('msg 2'), true);
  assertEquals(prompt.includes('reply 3'), true);
  assertEquals(prompt.includes('graph TD\nA-->B'), true);
  assertEquals(prompt.includes('syntax error on line 2'), true);
  assertEquals(prompt.includes('Use valid Mermaid'), true);
});

Deno.test('runTurn executes profile validation and auto-corrects', async () => {
  registerProfile({
    id: 'validatedProfile',
    identity: { handle: 'validated' },
    protocol: 'interactions',
    maxSteps: 1,
    models: { allow: ['gemini35FlashLite'], thinking: 'minimal' },
    controls: [],
    tools: { allow: [] },
    key: 'portfolio',
    inputs: { text: true },
    outputs: { structured: 'validTurn', media: false },
    commit: 'artifact',
    validation: {
      extract: (s) => (s as { code?: string })?.code,
      validate: (code) => {
        if (code === 'good') return { isValid: true };
        return { isValid: false, error: 'code must be good' };
      },
      maxRetries: 1,
      repairGuidance: 'emit good code',
    },
    quota: { perDay: 10 },
  });

  let callCount = 0;
  async function* mockRepairComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield { type: 'structured', structured: { code: 'bad' } };
    } else {
      assertEquals(req.input.some((p) => p.type === 'text' && p.text.includes('code must be good')), true);
      yield { type: 'structured', structured: { code: 'good' } };
    }
  }

  const events = await collect(
    runTurn(
      { profile: 'validatedProfile', input: { text: 'make code' } },
      { complete: mockRepairComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(events.filter((e) => e.type === 'structured').length, 1);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, { code: 'good' });
  assertEquals(events.at(-1)?.type, 'done');
});

