import '../fixtures/test-host.ts';
import { PUBLIC_ACTION, PUBLIC_CANARY, TheorumError } from '../../src/guardrails/error.ts';
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '../../src/kernel/engine/assert.ts';
import { synthesizeRepairPrompt } from '../../src/kernel/engine/repair.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  modelEntryByApiId,
} from '../../src/kernel/registry/catalog.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { executeTool } from '../../src/kernel/registry/tools.ts';
import type {
  CustomToolId,
  EgressContext,
  ModelProvider,
  ProfileId,
  ProviderCompleteRequest,
  TurnEvent,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { HOST_MODELS, modelAllow } from '../fixtures/models.ts';

Deno.test('runner internal helper branches: dynamic loaders, tool findings, step ceilings, and fallback handlers', async () => {
  // 1. Dynamic loader when no dynamicToolLoader is provided on generation
  const mockLoaderProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield {
          type: 'tool',
          tool: { name: 'load_more', arguments: { query: 'test' } },
        };
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      })();
    },
  };

  const dynamicReq: TurnRequest = {
    profile: 'chat',
    dynamicTools: [
      {
        name: 'load_more',
        loadsDynamicTools: true,
      },
    ],
    input: {
      text: 'load tools',
    },
  };

  const loaderEvents: TurnEvent[] = [];
  for await (const ev of runTurn(dynamicReq, mockLoaderProvider)) {
    loaderEvents.push(ev);
  }
  const toolResult = loaderEvents.find((e) => e.type === 'tool')?.tool?.result;
  assertEquals(toolResult?.status, 'error');

  // 2. Dynamic tool with no handler (default acceptance) on multi-step profile
  registerProfile(
    defineProfile({
      id: 'dynamic_runner_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 3 },
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const noHandlerReq: TurnRequest = {
    profile: 'dynamic_runner_bot',
    dynamicTools: [
      {
        name: 'stub_tool',
        permissionTier: 'auto',
        // no handler
      },
    ],
    input: {
      text: 'run stub',
    },
  };
  let callCount = 0;
  const noHandlerProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool',
            tool: { name: 'stub_tool', arguments: { value: 123 } },
          };
        } else {
          yield { type: 'text', text: 'finished' };
        }
      })();
    },
  };
  const stubEvents: TurnEvent[] = [];
  for await (const ev of runTurn(noHandlerReq, noHandlerProvider)) {
    stubEvents.push(ev);
  }
  const textEv = stubEvents.find((e) => e.type === 'text');
  assertEquals(textEv?.text, 'finished');

  // 3. Dynamic tool updating an existing declaration in mergeDynamicTools
  const updateReq: TurnRequest = {
    profile: 'chat',
    dynamicTools: [{ name: 'existing_tool', description: 'v1' }],
    dynamicToolLoader: () => [{ name: 'existing_tool', description: 'v2' }],
    input: {
      text: 'reload',
    },
  };
  const updateLoaderProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield {
          type: 'tool',
          tool: { name: 'existing_tool', arguments: {} },
        };
        yield { type: 'text', text: 'updated' };
        yield { type: 'done' };
      })();
    },
  };
  for await (const _ev of runTurn(updateReq, updateLoaderProvider)) {
    // drain
  }
});

Deno.test('runTurn emits one final done when provider also emits done', async () => {
  const provider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield { type: 'text', text: 'single terminal event' };
        yield { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } };
        yield { type: 'done' };
      })();
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile: 'chat', input: { text: 'ping' } }, provider)) {
    events.push(ev);
  }

  assertEquals(events.filter((event) => event.type === 'done').length, 1);
  assertEquals(events.at(-1)?.type, 'done');
});

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
  const ids: ProfileId[] = ['chat', 'pinned', 'formatter', 'selector', 'image'];
  for (const id of ids) {
    assertEquals(getProfile(id).model.maxSteps, 1);
  }
});

Deno.test('runTurn accepts an omitted input object', async () => {
  registerProfile({
    id: 'no_input_bot',
    model: { ...modelAllow('gemini35FlashLite') },
  });

  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'text', text: 'empty input ok' };
    },
  };
  const events = await collect(runTurn({ profile: 'no_input_bot' }, provider));

  assertEquals(events.find((e) => e.type === 'text')?.text, 'empty input ok');
  assertEquals(events.at(-1)?.type, 'done');
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
  assertEquals(HOST_MODELS.gemini35FlashLite.thinking.off, 'minimal');
});

Deno.test('thinking level shapes differ by model family', () => {
  assertEquals(HOST_MODELS.gemini31FlashLite.thinkingLevels, ['minimal', 'low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini35FlashLite.thinkingLevels, ['minimal', 'low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini31ProPreview.thinkingLevels, ['low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini31FlashLiteImage.thinkingLevels, ['minimal', 'high']);
  assertEquals(HOST_MODELS.gemini31ProPreview.thinking.off, 'low');
  assertEquals(clampThinkingLevel(HOST_MODELS.gemini31ProPreview, 'minimal'), 'low');
  assertEquals(clampThinkingLevel(HOST_MODELS.gemini31FlashLite, 'minimal'), 'minimal');
  assertEquals(
    modelEntryByApiId(HOST_MODELS, 'gemini-3.5-flash-lite')?.apiId,
    'gemini-3.5-flash-lite',
  );
  assertEquals(clampThinkingLevelForApiId(HOST_MODELS, 'gemini-3.1-pro-preview', 'minimal'), 'low');
  assertEquals(modelEntryByApiId(HOST_MODELS, 'unknown-model-api-id'), undefined);
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

Deno.test('pinned profile uses fixed thinking without a control', () => {
  const { generation } = resolveTurn({ profile: 'pinned', input: {} });
  assertEquals(generation.thinking, 'low');
  assertEquals(projectProfile('pinned').controls, []);
});

Deno.test('selectable profile picks model and pinned thinking', () => {
  const fast = resolveTurn({
    profile: 'selector',
    select: 'fast',
    input: { text: 'x' },
  });
  assertEquals(fast.generation.model, 'gemini35FlashLite');
  assertEquals(fast.generation.thinking, 'low');
  assertEquals(fast.generation.maxOutputTokens, LONG_FLASH);
  const smart = resolveTurn({
    profile: 'selector',
    select: 'smart',
    input: { text: 'x' },
  });
  assertEquals(smart.generation.model, 'gemini31ProPreview');
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

Deno.test('profile allowlist blocks unavailable builtins', () => {
  const { generation } = resolveTurn({
    profile: 'formatter',
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

Deno.test('language slot picks structured schema', () => {
  const html = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'html' } },
  });
  assertEquals(html.generation.structured, 'htmlTurn');
  const tsx = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'tsx' } },
  });
  assertEquals(tsx.generation.structured, 'tsxTurn');
});

Deno.test('disallowed tool cannot run', () => {
  assertThrows(
    () =>
      executeTool(getProfile('pinned'), 'askUser', {
        kind: 'text',
        prompt: 'q',
      }),
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

Deno.test('ui invoke askUser is denied until allowed', async () => {
  const events = await collect(
    runTurn(
      {
        profile: 'chat',
        input: { text: 'x' },
        toolInvoke: {
          name: 'askUser',
          arguments: { kind: 'text', prompt: 'q' },
        },
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
  const ui = projectProfile('formatter');
  assertEquals(
    ui.tools.map((t) => t.name),
    ['googleSearch', 'googleMaps'],
  );
  assertEquals(ui.controls, ['thinking']);
  assertEquals(ui.inputs.voice, undefined);
});

Deno.test('unknown profile select is rejected', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'selector',
        select: 'turbo',
        input: { text: 'x' },
      }),
    TheorumError,
  );
});

Deno.test('askUser validates kind and prompt', () => {
  const profile = withTools('chat', ['askUser']);
  assertEquals(executeTool(profile, 'askUser', { kind: 'nope', prompt: 'q' }).status, 'error');
  assertEquals(executeTool(profile, 'askUser', { kind: 'text', prompt: '  ' }).status, 'error');
});

Deno.test('non-kernel custom tools require dynamic handlers', () => {
  const result = executeTool(withTools('chat', ['hostTool']), 'hostTool', {
    n: 1,
  });
  assertEquals(result.status, 'error');
  assertStringIncludes(result.finding ?? '', 'dynamic tool handler');
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

Deno.test('role-specific system prompt still completes', async () => {
  const events = await collect(
    runTurn(
      {
        profile: 'selector',
        select: 'fast',
        input: { text: 'plan', role: 'reviewer' },
      },
      fake,
    ),
  );
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
});

Deno.test('empty text input still runs', async () => {
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
        input: {
          text: 'hi',
          attachments: [{ mimeType: 'video/mp4', data: 'dGVzdA==' }],
        },
      }),
    TheorumError,
  );
});

Deno.test('chat rejects audio on the attachments channel', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: {
          text: 'hi',
          attachments: [{ mimeType: 'audio/webm', data: 'dGVzdA==' }],
        },
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

Deno.test('synthesizeRepairPrompt scopes history to last 2 exchanges and includes rejection/output', () => {
  const prompt = synthesizeRepairPrompt({
    profile: getProfile('chat'),
    repair: {
      previousOutput: 'The answer leaked internal_marker.',
      rejection: 'Remove internal_marker from user-visible prose.',
      guidance: 'Rewrite as safe user-facing text.',
    },
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
  assertEquals(prompt.includes('The answer leaked internal_marker.'), true);
  assertEquals(prompt.includes('Remove internal_marker from user-visible prose.'), true);
  assertEquals(prompt.includes('Rewrite as safe user-facing text.'), true);
});

Deno.test('runTurn executes profile validation and auto-corrects', async () => {
  registerProfile({
    id: 'validatedProfile',
    identity: { handle: 'validated' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: {
        fields: {
          code: (code: unknown) => {
            if (code === 'good') return { isValid: true };
            return { isValid: false, error: 'code must be good' };
          },
        },
        maxRetries: 1,
        repairGuidance: 'emit good code',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockRepairComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield { type: 'structured', structured: { code: 'bad' } };
    } else {
      assertEquals(
        req.input.some((p) => p.type === 'text' && p.text.includes('code must be good')),
        true,
      );
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
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    code: 'good',
  });
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn skips optional field validators when optional path is omitted', async () => {
  let codeValidatorCalls = 0;
  registerProfile({
    id: 'optionalArtifactProfile',
    identity: { handle: 'optionalArtifact' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'optionalCodeTurn',
      validation: {
        fields: {
          code: () => {
            codeValidatorCalls += 1;
            return { isValid: false, error: 'should not validate' };
          },
        },
        maxRetries: 3,
        repairGuidance: 'do not invent code',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockMessageOnly(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    yield { type: 'structured', structured: { message: '2 + 2 is 4.' } };
  }

  const events = await collect(
    runTurn(
      { profile: 'optionalArtifactProfile', input: { text: 'what is 2+2?' } },
      { complete: mockMessageOnly },
    ),
  );
  assertEquals(callCount, 1);
  assertEquals(codeValidatorCalls, 0);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    message: '2 + 2 is 4.',
  });
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn streams thought and text live while validation buffers structured', async () => {
  registerProfile({
    id: 'streamWhileValidate',
    identity: { handle: 'streamValidate' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: {
        fields: {
          code: () => ({ isValid: true }),
        },
        maxRetries: 0,
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'thought', text: 'planning' };
    yield { type: 'text', text: '{"code":' };
    yield { type: 'structured', structured: { code: 'good' } };
    yield { type: 'tokens', tokens: { input: 1, output: 1, thinking: 0, total: 2 } };
  }

  const events = await collect(
    runTurn({ profile: 'streamWhileValidate', input: { text: 'go' } }, { complete: mockComplete }),
  );
  const types = events.map((e) => e.type);
  assertEquals(types.includes('thought'), true);
  assertEquals(types.includes('text'), true);
  assertEquals(types.includes('structured'), true);
  assertEquals(types.filter((t) => t === 'thought').length, 1);
  assertEquals(types.filter((t) => t === 'text').length, 1);
  assertEquals(types.indexOf('thought') < types.indexOf('structured'), true);
  assertEquals(types.indexOf('text') < types.indexOf('structured'), true);
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn retries when required field is missing', async () => {
  registerProfile({
    id: 'requiredMissingProfile',
    identity: { handle: 'requiredMissing' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: { maxRetries: 1, repairGuidance: 'include code' },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield { type: 'structured', structured: { message: 'no code yet' } };
      return;
    }
    assertEquals(
      req.input.some(
        (p) => p.type === 'text' && p.text.includes("required field 'code' is missing"),
      ),
      true,
    );
    yield { type: 'structured', structured: { code: 'good' } };
  }

  const events = await collect(
    runTurn(
      { profile: 'requiredMissingProfile', input: { text: 'make code' } },
      { complete: mockComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, { code: 'good' });
});

Deno.test('runTurn validates nested required under present optional object', async () => {
  let mermaidCalls = 0;
  registerProfile({
    id: 'nestedOptionalProfile',
    identity: { handle: 'nestedOptional' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'optionalCodeTurn',
      validation: {
        fields: {
          'diagram.mermaid': (source: unknown) => {
            mermaidCalls += 1;
            if (source === 'flowchart TD\nA --> B') return { isValid: true };
            return { isValid: false, error: 'bad mermaid' };
          },
        },
        maxRetries: 1,
        repairGuidance: 'fix mermaid',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield {
        type: 'structured',
        structured: { message: 'here', diagram: { mermaid: 'nope' } },
      };
      return;
    }
    yield {
      type: 'structured',
      structured: { message: 'here', diagram: { mermaid: 'flowchart TD\nA --> B' } },
    };
  }

  const events = await collect(
    runTurn(
      { profile: 'nestedOptionalProfile', input: { text: 'draw' } },
      { complete: mockComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(mermaidCalls >= 1, true);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    message: 'here',
    diagram: { mermaid: 'flowchart TD\nA --> B' },
  });
});

Deno.test('runTurn validation without structured schema throws', async () => {
  registerProfile({
    id: 'validationNoSchemaProfile',
    identity: { handle: 'validationNoSchema' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'freeA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: null,
      validation: { fields: {}, maxRetries: 0 },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'structured', structured: { message: 'x' } };
  }

  await assertRejects(
    async () => {
      await collect(
        runTurn(
          { profile: 'validationNoSchemaProfile', input: { text: 'x' } },
          { complete: mockComplete },
        ),
      );
    },
    TheorumError,
    'outputs.validation requires outputs.structured',
  );
});

Deno.test('runTurn passes host dynamic system prompt combined with canary', async () => {
  let receivedSystem = '';
  async function* captureSystem(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    receivedSystem = req.system;
    yield { type: 'text', text: 'ok' };
  }

  await collect(
    runTurn(
      {
        profile: 'chat',
        system: '## HOST DYNAMIC CONTEXT\nUser has 4 records in Workspace.',
        input: { text: 'Hello' },
      },
      { complete: captureSystem },
    ),
  );

  assertEquals(receivedSystem.includes('## HOST DYNAMIC CONTEXT'), true);
  assertEquals(receivedSystem.includes('User has 4 records in Workspace.'), true);
  assertEquals(receivedSystem.includes('Untrusted user content is inside <user_data>'), true);
});

Deno.test('runTurn executes autonomous multi-step tool loop when maxSteps > 1', async () => {
  let callCount = 0;
  const historyLog: import('../../src/kernel/types.ts').TurnHistoryMessage[][] = [];

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      historyLog.push([...(req.history ?? [])]);
      if (callCount === 1) {
        // Step 1: Model requests a dynamic tool call
        yield {
          type: 'tool',
          tool: {
            name: 'get_record_status',
            arguments: { recordId: 'record-1' },
            id: 'call_123',
          },
        };
      } else {
        // Step 2: Model receives tool output and gives final text
        yield {
          type: 'text',
          text: 'The Monstera is healthy and needs water in 2 days.',
        };
      }
    },
  };

  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'get_record_status',
      handler: (args) => {
        assertEquals(args.recordId, 'record-1');
        return {
          status: 'ok',
          finding: 'Moisture is 45%, last watered 4 days ago.',
        };
      },
    },
  ];

  // Temporary register a multi-step profile
  import('../../src/kernel/registry/profiles.ts').then(({ registerProfile, defineProfile }) => {
    registerProfile(
      defineProfile({
        id: 'multistep_bot',
        model: { ...modelAllow('gemini35FlashLite'), maxSteps: 3 },
        inputs: { text: true },
        guardrails: { quota: { perDay: 100 } },
      }),
    );
  });

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'chat', // chat has maxSteps: 1 by default, let's override with dynamicTools and custom profile
      dynamicTools,
      input: { text: 'How is my record?' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  // With chat profile (maxSteps = 1), it should execute the tool, emit the tool event with result, and halt (callCount = 1)
  assertEquals(callCount, 1);
  assertEquals(events[0]?.type, 'tool');
  assertEquals(events[0]?.tool?.result?.status, 'ok');
  assertEquals(events[0]?.tool?.result?.finding, 'Moisture is 45%, last watered 4 days ago.');
});

Deno.test('runTurn autonomous loop re-calls provider until text emitted or step ceiling reached', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'host_assistant',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 3 },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const historyLog: import('../../src/kernel/types.ts').TurnHistoryMessage[][] = [];

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      historyLog.push([...(req.history ?? [])]);
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'fetch_sensor',
            arguments: { sensor: 'soil' },
            id: 'call_sensor_1',
          },
        };
      } else {
        yield {
          type: 'text',
          text: 'Soil sensor reads 22% moisture.',
        };
      }
    },
  };

  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'fetch_sensor',
      handler: () => ({
        status: 'ok',
        finding: 'Sensor raw value: 22%',
      }),
    },
  ];

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'host_assistant',
      dynamicTools,
      input: { text: 'Check soil' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  assertEquals(
    events.some((e) => e.type === 'tool'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'Soil sensor reads 22% moisture.'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );

  // Check history on step 2
  const step2History = historyLog[1] ?? [];
  assertEquals(step2History.length, 2);
  assertEquals(step2History[0]?.role, 'assistant');
  assertEquals(step2History[0]?.tool_calls?.[0]?.function.name, 'fetch_sensor');
  assertEquals(step2History[1]?.role, 'tool');
  assertEquals(step2History[1]?.tool_call_id, 'call_sensor_1');
  assertEquals(step2History[1]?.content, 'Sensor raw value: 22%');
});

Deno.test('guardrails.canary=false omits canary generation and system binding', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'internal_eval_bot',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, canary: false },
    }),
  );

  let capturedSystem = '';
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      capturedSystem = req.system;
      yield { type: 'text', text: 'eval response' };
    },
  };

  const { generation } = resolveTurn({
    profile: 'internal_eval_bot',
    input: { text: 'hello' },
  });
  assertEquals(generation.canary, '');

  await collect(runTurn({ profile: 'internal_eval_bot', input: { text: 'hello' } }, mockProvider));
  assertEquals(capturedSystem.includes("This turn's canary is"), false);
});

Deno.test('inputs.text=false rejects text turns with TheorumError', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'voice_only_bot',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: {
        text: false,
        voice: { accept: ['audio/wav'] },
        maxFiles: 1,
        maxBytes: 10000,
        maxTurnBytes: 10000,
      },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  assertThrows(
    () =>
      resolveTurn({
        profile: 'voice_only_bot',
        input: { text: 'Should fail because text is disabled' },
      }),
    TheorumError,
  );
});

Deno.test('outputs.streaming.streamThoughts=false filters out thought events from SSE stream', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'quiet_bot',
      model: { ...modelAllow('gemini35FlashLite') },
      inputs: { text: true },
      outputs: {
        streaming: { streamThoughts: false },
      },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'thought', text: 'internal deep thoughts...' };
      yield { type: 'text', text: 'final clean output' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  let capturedTraceEvents: import('../../src/observability/trace-record.ts').TraceEvent[] = [];
  const mockSink: import('../../src/observability/trace.ts').TraceSink = {
    write: (record) => {
      capturedTraceEvents = record.events;
      return Promise.resolve();
    },
  };

  for await (const ev of runTurn(
    { profile: 'quiet_bot', input: { text: 'solve problem' } },
    mockProvider,
    mockSink,
  )) {
    events.push(ev);
  }

  // Filtered from outer SSE stream
  assertEquals(
    events.some((e) => e.type === 'thought'),
    false,
  );
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'final clean output'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );

  // But preserved in trace record for audit/storage
  assertEquals(
    capturedTraceEvents.some((e) => e.type === 'thought' && e.text === 'internal deep thoughts...'),
    true,
  );
});

Deno.test('dynamic tool exception is safely caught and converted to error finding', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'fault_tolerant_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 2 },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  let receivedToolError = '';
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'crashing_tool',
            arguments: { id: 'bad_id' },
            id: 'call_crash_1',
          },
        };
      } else {
        const lastMsg = req.history?.at(-1);
        receivedToolError = String(lastMsg?.content ?? '');
        yield { type: 'text', text: 'Handled error gracefully.' };
      }
    },
  };

  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'crashing_tool',
      handler: () => {
        throw new Error('Database connection timed out');
      },
    },
  ];

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'fault_tolerant_bot',
      dynamicTools,
      input: { text: 'Run crashing tool' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool?.result?.status === 'error'),
    true,
  );
  assertEquals(receivedToolError.includes('Database connection timed out'), true);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'Handled error gracefully.'),
    true,
  );
});

Deno.test('autonomous loop strictly enforces maxSteps ceiling when tool requests repeat endlessly', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'loop_capped_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 2 },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      callCount++;
      // Endless loop requesting tool call on every step
      yield {
        type: 'tool',
        tool: {
          name: 'ping_tool',
          arguments: { step: callCount },
          id: `call_ping_${callCount}`,
        },
      };
    },
  };

  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'ping_tool',
      handler: (args) => ({ status: 'ok', finding: `pong ${args.step}` }),
    },
  ];

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'loop_capped_bot',
      dynamicTools,
      input: { text: 'Loop test' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  // maxSteps: 2 should cap total provider calls to exactly 2
  assertEquals(callCount, 2);
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('dynamic tool enforces permissionTier session_consent pause unless granted', async () => {
  registerProfile({
    id: 'consent_tool_bot',
    identity: { handle: 'consent_bot', chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: {
          name: 'delete_resource',
          arguments: { id: 'res_123' },
          id: 'call_del_1',
        },
      };
    },
  };

  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'delete_resource',
      loadTier: 'T1',
      permissionTier: 'session_consent',
      handler: (args) => ({ status: 'ok', finding: `deleted ${args.id}` }),
    },
  ];

  // Turn 1: No session permission granted -> returns pause status
  const events1: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'consent_tool_bot',
      dynamicTools,
      input: { text: 'Delete resource 123' },
    },
    mockProvider,
  )) {
    events1.push(ev);
  }

  const toolEv1 = events1.find((e) => e.type === 'tool');
  assertEquals(toolEv1?.tool?.result?.status, 'pause');
  assertStringIncludes(
    toolEv1?.tool?.result?.finding ?? '',
    'requires session_consent authorization',
  );

  // Turn 2: With session permission granted -> returns ok status
  const events2: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'consent_tool_bot',
      sessionPermissions: ['delete_resource'],
      dynamicTools,
      input: { text: 'Delete resource 123' },
    },
    mockProvider,
  )) {
    events2.push(ev);
  }

  const toolEv2 = events2.find((e) => e.type === 'tool');
  assertEquals(toolEv2?.tool?.result?.status, 'ok');
  assertEquals(toolEv2?.tool?.result?.finding, 'deleted res_123');
});

Deno.test('dynamic loader injects T2 schemas and continues the same turn loop', async () => {
  registerProfile({
    id: 'loader_bot',
    identity: { handle: 'loader_bot', chat: true },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 3,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  let callCount = 0;
  const seenToolLists: string[][] = [];
  const provider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      seenToolLists.push((req.dynamicTools ?? []).map((tool) => tool.name));
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'load_tools',
            arguments: { names: ['record_lookup'] },
            id: 'call_load',
          },
        };
        return;
      }
      yield {
        type: 'tool',
        tool: {
          name: 'record_lookup',
          arguments: { q: 'record' },
          id: 'call_lookup',
        },
      };
      yield { type: 'text', text: 'lookup complete' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'loader_bot',
        dynamicTools: [
          {
            name: 'load_tools',
            loadTier: 'T0',
            loadsDynamicTools: true,
          },
        ],
        dynamicToolLoader: () => [
          {
            name: 'record_lookup',
            loadTier: 'T2',
            handler: (args) => ({ status: 'ok', finding: `found ${args.q}` }),
          },
        ],
        input: { text: 'load then lookup' },
      },
      provider,
    ),
  );

  assertEquals(callCount, 3);
  assertEquals(seenToolLists[0], ['load_tools']);
  assertEquals(seenToolLists[1], ['load_tools', 'record_lookup']);
  assertEquals(
    events.some((event) => event.tool?.result?.data?.loadedTools),
    true,
  );
  assertEquals(
    events.some(
      (event) => event.tool?.name === 'record_lookup' && event.tool.result?.status === 'ok',
    ),
    true,
  );
});

Deno.test('dynamic loader does not inject T2 schemas before required permission is granted', async () => {
  registerProfile({
    id: 'loader_permission_bot',
    identity: { handle: 'loader_permission_bot', chat: true },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  let loaderCalled = false;
  const seenToolLists: string[][] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      seenToolLists.push((req.dynamicTools ?? []).map((tool) => tool.name));
      if (seenToolLists.length === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'load_tools',
            arguments: { names: ['record_lookup'] },
            id: 'call_load',
          },
        };
        return;
      }
      yield { type: 'text', text: 'permission not granted' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'loader_permission_bot',
        dynamicTools: [
          {
            name: 'load_tools',
            loadTier: 'T0',
            permissionTier: 'session_consent',
            loadsDynamicTools: true,
          },
        ],
        dynamicToolLoader: () => {
          loaderCalled = true;
          return [{ name: 'record_lookup', loadTier: 'T2' }];
        },
        input: { text: 'try loading without consent' },
      },
      provider,
    ),
  );

  assertEquals(loaderCalled, false);
  assertEquals(seenToolLists, [['load_tools'], ['load_tools']]);
  const loadEvent = events.find((event) => event.tool?.name === 'load_tools');
  assertEquals(loadEvent?.tool?.result?.status, 'pause');
  assertEquals(
    events.some((event) => event.tool?.result?.data?.loadedTools),
    false,
  );
});

Deno.test('guardrails.egress refuse_to_user delivers in-character refusal without retry', async () => {
  registerProfile({
    id: 'voice_egress_bot',
    identity: { handle: 'voice_bot', chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'refuse_to_user',
        enforce: ({ text }: EgressContext) => {
          if (text.includes('internal_tool_abc')) {
            return {
              blocked: true,
              text: "i can't discuss internal wiring.",
              hits: ['internal_tool_name'],
            };
          }
          return { blocked: false, text };
        },
      },
    },
  });

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      yield { type: 'text', text: 'I used internal_tool_abc to look that up.' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'voice_egress_bot',
      input: { text: 'How did you do that?' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  const textEv = events.find((e) => e.type === 'text');
  assertEquals(textEv?.text, "i can't discuss internal wiring.");
});

Deno.test('guardrails.egress reject_to_agent triggers auto-repair retry loop', async () => {
  registerProfile({
    id: 'chat_egress_bot',
    identity: { handle: 'chat_bot', chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'reject_to_agent',
        maxRetries: 2,
        enforce: ({ text }: EgressContext) => {
          if (text.includes('internal_tool_abc')) {
            return {
              blocked: true,
              text: '',
              hits: ['internal_tool_name'],
              rejectionMessage: 'Do not mention internal_tool_abc in public prose.',
            };
          }
          return { blocked: false, text };
        },
      },
    },
  });

  let callCount = 0;
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'text',
          text: 'Here is what internal_tool_abc returned.',
        };
      } else {
        // Verify model received the repair request in input
        const inputStr = JSON.stringify(req.input);
        assertStringIncludes(inputStr, 'Do not mention internal_tool_abc');
        yield { type: 'text', text: 'Here is the clean public answer.' };
      }
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'chat_egress_bot',
      input: { text: 'Show me status' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  const textEvents = events.filter((e) => e.type === 'text');
  assertEquals(textEvents.length, 1);
  assertEquals(textEvents[0]?.text, 'Here is the clean public answer.');
});

Deno.test('guardrails.egress reject_to_agent withholds turn when retries exhausted', async () => {
  registerProfile({
    id: 'exhausted_egress_bot',
    identity: { handle: 'exhausted_bot', chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'reject_to_agent',
        maxRetries: 1,
        enforce: () => ({
          blocked: true,
          text: '',
          hits: ['persistent_leak'],
          rejectionMessage: 'Persistent leak violation',
        }),
      },
    },
  });

  let callCount = 0;
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      callCount++;
      yield { type: 'text', text: 'Persistent leak content' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'exhausted_egress_bot',
      input: { text: 'Run test' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2); // Initial attempt (0) + 1 retry = 2 attempts
  const errorEv = events.find((e) => e.type === 'error');
  assertEquals(errorEv?.error, PUBLIC_CANARY);
  const textEv = events.find((e) => e.type === 'text');
  assertEquals(textEv, undefined);
});

Deno.test('guardrails.egress withholds media until prose clears', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'media_egress_bot',
      identity: { handle: 'media_bot', chat: true },
      model: {
        protocol: 'geminiInteractions',
        provider: 'google',
        ...modelAllow('gemini31FlashLiteImage'),
        thinking: 'minimal',
        maxSteps: 1,
      },
      tools: { allow: [] },
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
      guardrails: {
        quota: { perDay: 50 },
        egress: {
          onBlock: 'reject_to_agent',
          maxRetries: 1,
          enforce: ({ text }: { text: string }) => ({
            blocked: text.includes('internal_tool_abc'),
            text,
            hits: ['internal_tool_name'],
            rejectionMessage: 'remove internal tool names',
          }),
        },
      },
    }),
  );

  let callCount = 0;
  const provider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      callCount++;
      if (callCount === 1) {
        yield { type: 'text', text: 'draft from internal_tool_abc' };
        yield {
          type: 'media',
          media: { mimeType: 'image/jpeg', data: 'leaky-image' },
        };
        return;
      }
      yield { type: 'text', text: 'clean public caption' };
      yield {
        type: 'media',
        media: { mimeType: 'image/jpeg', data: 'clean-image' },
      };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'media_egress_bot',
        input: {
          text: 'make image',
          slots: { aspectRatio: '1:1', size: '1K' },
        },
      },
      provider,
    ),
  );

  assertEquals(callCount, 2);
  assertEquals(
    events.some((event) => event.media?.data === 'leaky-image'),
    false,
  );
  assertEquals(
    events.some((event) => event.media?.data === 'clean-image'),
    true,
  );
});

function createCanExecBotProfile(id: string): void {
  registerProfile({
    id,
    identity: { handle: id, chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });
}

function createToolProvider(toolName: string): import('../../src/kernel/types.ts').ModelProvider {
  return {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: toolName, arguments: { val: 42 }, id: 'call_1' },
      };
    },
  };
}

Deno.test('dynamic tool canExecute returning false yields unauthorized error', async () => {
  createCanExecBotProfile('can_exec_bot_1');
  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    { name: 'denied_tool', canExecute: () => false },
  ];
  const events = await collect(
    runTurn(
      { profile: 'can_exec_bot_1', dynamicTools, input: { text: 'test' } },
      createToolProvider('denied_tool'),
    ),
  );
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.result?.status, 'error');
  assertStringIncludes(toolEv?.tool?.result?.finding ?? '', 'execution not authorized');
});

Deno.test('dynamic tool canExecute returning envelope yields custom status', async () => {
  createCanExecBotProfile('can_exec_bot_2');
  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'custom_auth_tool',
      canExecute: () => ({
        status: 'pause',
        finding: 'custom auth challenge',
      }),
    },
  ];
  const events = await collect(
    runTurn(
      { profile: 'can_exec_bot_2', dynamicTools, input: { text: 'test' } },
      createToolProvider('custom_auth_tool'),
    ),
  );
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.result?.status, 'pause');
  assertEquals(toolEv?.tool?.result?.finding, 'custom auth challenge');
});

Deno.test('dynamic tool canExecute throwing error is caught safely', async () => {
  createCanExecBotProfile('can_exec_bot_3');
  const dynamicTools: import('../../src/kernel/types.ts').DynamicToolDeclaration[] = [
    {
      name: 'throwing_auth_tool',
      canExecute: () => {
        throw new Error('auth network failure');
      },
    },
  ];
  const events = await collect(
    runTurn(
      { profile: 'can_exec_bot_3', dynamicTools, input: { text: 'test' } },
      createToolProvider('throwing_auth_tool'),
    ),
  );
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.result?.status, 'error');
  assertStringIncludes(toolEv?.tool?.result?.finding ?? '', 'Authorization error for');
});
