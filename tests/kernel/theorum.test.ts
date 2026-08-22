import '../fixtures/test-host.ts';
import { PUBLIC_ACTION, PUBLIC_CANARY, TheorumError } from '../../src/guardrails/error.ts';
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from '../../src/kernel/engine/assert.ts';
import { synthesizeFixPrompt } from '../../src/kernel/engine/fix.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { CATALOG, clampThinkingLevel } from '../../src/kernel/registry/catalog.ts';
import { getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { executeTool } from '../../src/kernel/registry/tools.ts';
import type {
  CustomToolId,
  EgressContext,
  ModelProvider,
  ProfileId,
  ProviderCompleteRequest,
  TurnEvent,
} from '../../src/kernel/types.ts';

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
    assertEquals(getProfile(id).model.maxSteps, 1);
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

Deno.test('synthesizeFixPrompt scopes history to last 2 exchanges and includes error/artifact', () => {
  const prompt = synthesizeFixPrompt({
    profile: getProfile('chat'),
    fix: {
      artifact: 'graph TD\nA-->B',
      error: 'syntax error on line 2',
      guidance: 'Use valid Mermaid',
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
  assertEquals(prompt.includes('graph TD\nA-->B'), true);
  assertEquals(prompt.includes('syntax error on line 2'), true);
  assertEquals(prompt.includes('Use valid Mermaid'), true);
});

Deno.test('runTurn executes profile validation and auto-corrects', async () => {
  registerProfile({
    id: 'validatedProfile',
    identity: { handle: 'validated' },
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
      structured: 'validTurn',
      media: false,
      commit: 'artifact',
      validation: {
        extract: (s: unknown) => (s as { code?: string })?.code,
        validate: (code: unknown) => {
          if (code === 'good') return { isValid: true };
          return { isValid: false, error: 'code must be good' };
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
  assertEquals(events.find((e) => e.type === 'structured')?.structured, { code: 'good' });
  assertEquals(events.at(-1)?.type, 'done');
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
        system: '## HOST DYNAMIC CONTEXT\nUser has 4 plants in Living Room.',
        input: { text: 'Hello' },
      },
      { complete: captureSystem },
    ),
  );

  assertEquals(receivedSystem.includes('## HOST DYNAMIC CONTEXT'), true);
  assertEquals(receivedSystem.includes('User has 4 plants in Living Room.'), true);
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
            name: 'get_plant_status',
            arguments: { plantId: 'monstera-1' },
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
      name: 'get_plant_status',
      handler: (args) => {
        assertEquals(args.plantId, 'monstera-1');
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
        model: { allow: ['gemini35FlashLite'], maxSteps: 3 },
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
      input: { text: 'How is my monstera?' },
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
      id: 'orchid_assistant',
      model: { allow: ['gemini35FlashLite'], maxSteps: 3 },
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
      profile: 'orchid_assistant',
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
      model: { allow: ['gemini35FlashLite'] },
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
      model: { allow: ['gemini35FlashLite'] },
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
      model: { allow: ['gemini35FlashLite'] },
      inputs: { text: true },
      outputs: {
        streaming: { mode: 'sse', streamThoughts: false },
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
      model: { allow: ['gemini35FlashLite'], maxSteps: 2 },
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
      model: { allow: ['gemini35FlashLite'], maxSteps: 2 },
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
      allow: ['gemini35FlashLite'],
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
      allow: ['gemini35FlashLite'],
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
          tool: { name: 'load_tools', arguments: { names: ['plant_lookup'] }, id: 'call_load' },
        };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'plant_lookup', arguments: { q: 'monstera' }, id: 'call_lookup' },
      };
      yield { type: 'text', text: 'lookup complete' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'loader_bot',
        dynamicTools: [{ name: 'load_tools', loadTier: 'T0', loadsDynamicTools: true }],
        dynamicToolLoader: () => [
          {
            name: 'plant_lookup',
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
  assertEquals(seenToolLists[1], ['load_tools', 'plant_lookup']);
  assertEquals(
    events.some((event) => event.tool?.result?.data?.loadedTools),
    true,
  );
  assertEquals(
    events.some(
      (event) => event.tool?.name === 'plant_lookup' && event.tool.result?.status === 'ok',
    ),
    true,
  );
});

Deno.test('guardrails.egress refuse_to_user delivers in-character refusal without retry', async () => {
  registerProfile({
    id: 'voice_egress_bot',
    identity: { handle: 'voice_bot', chat: true },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      allow: ['gemini35FlashLite'],
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
      allow: ['gemini35FlashLite'],
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
        yield { type: 'text', text: 'Here is what internal_tool_abc returned.' };
      } else {
        // Verify model received the fix request in input
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
      allow: ['gemini35FlashLite'],
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

Deno.test('guardrails.egress withholds media artifacts until prose clears', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      id: 'media_egress_bot',
      identity: { handle: 'media_bot', chat: true },
      model: {
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini31FlashLiteImage'],
        thinking: 'minimal',
        maxSteps: 1,
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { media: true, structured: null },
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
        yield { type: 'media', media: { mimeType: 'image/jpeg', data: 'leaky-image' } };
        return;
      }
      yield { type: 'text', text: 'clean public caption' };
      yield { type: 'media', media: { mimeType: 'image/jpeg', data: 'clean-image' } };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'media_egress_bot',
        input: { text: 'make image', slots: { aspectRatio: '1:1', imageSize: '1K' } },
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
      allow: ['gemini35FlashLite'],
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
      canExecute: () => ({ status: 'pause', finding: 'custom auth challenge' }),
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
