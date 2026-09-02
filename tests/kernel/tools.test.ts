import '../fixtures/test-host.ts';
import { z } from 'zod';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { formatToolResult, projectForModel } from '../../src/kernel/tools/execute.ts';
import { defineTool, getTool, registerTool } from '../../src/kernel/tools/mod.ts';
import { expandTurnToolLoader, prepareTurnToolSnapshot, promoteLoadedTools, resolveTurnTools } from '../../src/kernel/tools/resolve.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { modelAllow, HOST_MODELS } from '../fixtures/models.ts';
import { gateTools, invokeRegisteredTool } from '../fixtures/test-tools.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

Deno.test('runTurn ends with stop kind tool when execution pauses', async () => {
  registerProfile({
    id: 'pause_stop_probe',
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      maxSteps: 2,
    },
    tools: { allow: ['delete_resource'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'delete_resource', arguments: { id: 'x' }, id: 'c1' },
      };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'pause_stop_probe',
        tools: gateTools('delete_resource'),
        input: { text: 'delete' },
      },
      provider,
    ),
  );

  assertEquals(
    events.some((e) => e.tool?.phase === 'pause'),
    true,
  );
  assertEquals(events.at(-1)?.stop?.kind, 'tool');
});

Deno.test('always_confirm ignores session permissions until resume.granted', async () => {
  registerProfile({
    id: 'always_confirm_probe',
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      ...modelAllow('gemini35FlashLite'),
      maxSteps: 1,
    },
    tools: { allow: ['always_confirm_tool'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'always_confirm_tool', arguments: {}, id: 'c1' },
      };
    },
  };

  const paused = await collect(
    runTurn(
      {
        profile: 'always_confirm_probe',
        tools: gateTools('always_confirm_tool'),
        sessionPermissions: ['always_confirm_tool'],
        input: { text: 'go' },
      },
      provider,
    ),
  );
  assertEquals(
    paused.findLast((e) => e.tool?.name === 'always_confirm_tool')?.tool?.phase,
    'pause',
  );

  const resumed = await invokeRegisteredTool({
    profile: 'always_confirm_probe',
    name: 'always_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(
    resumed.findLast((e) => e.tool?.name === 'always_confirm_tool')?.tool?.phase,
    'complete',
  );
});

Deno.test('ungated allowed tool returns not_gated not not_loaded', async () => {
  registerProfile(
    defineProfile({
      id: 'ungated_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const { generation } = resolveTurn({ profile: 'ungated_probe', input: { text: 'x' } });
  assertEquals(generation.tools.gated.includes('stub_tool'), false);

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'stub_tool', arguments: {}, id: 'c1' },
      };
    },
  };

  const events = await collect(
    runTurn({ profile: 'ungated_probe', input: { text: 'x' } }, provider),
  );
  const toolEv = events.findLast((e) => e.tool?.name === 'stub_tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_gated');
});

Deno.test('preflight confirmation emits pause not error', async () => {
  registerProfile(
    defineProfile({
      id: 'preflight_confirm_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['preflight_confirm_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'preflight_confirm_bot',
    name: 'preflight_confirm_tool',
    input: {},
    tools: gateTools('preflight_confirm_tool'),
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'preflight_confirm_tool');
  assertEquals(toolEv?.tool?.phase, 'pause');
  assertEquals(toolEv?.tool?.pause?.kind, 'confirmation');
});

Deno.test('streaming handler forwards progress before complete', async () => {
  registerProfile(
    defineProfile({
      id: 'streaming_probe_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['streaming_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'streaming_probe', arguments: {}, id: 'c1' },
      };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'streaming_probe_bot',
        tools: gateTools('streaming_probe'),
        input: { text: 'stream' },
      },
      provider,
    ),
  );

  assertEquals(
    events.some((e) => e.tool?.phase === 'progress'),
    true,
  );
  assertEquals(
    events.some((e) => e.tool?.phase === 'trace'),
    true,
  );
  assertEquals(
    events.some((e) => e.tool?.phase === 'artifact'),
    true,
  );
  assertEquals(
    events.some((e) => e.tool?.phase === 'warning'),
    true,
  );
  assertEquals(events.findLast((e) => e.tool?.name === 'streaming_probe')?.tool?.phase, 'complete');
});

Deno.test('invokeTool without turn gate returns not_gated', async () => {
  registerProfile(
    defineProfile({
      id: 'invoke_gate_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_gate_probe',
    name: 'stub_tool',
    input: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'stub_tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_gated');
  assertEquals(events.at(-1)?.stop?.kind, 'tool');
});

Deno.test('invokeTool success ends with stop kind completed', async () => {
  registerProfile(
    defineProfile({
      id: 'invoke_complete_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_complete_probe',
    name: 'stub_tool',
    input: {},
    tools: gateTools('stub_tool'),
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'stub_tool')?.tool?.phase, 'complete');
  assertEquals(events.at(-1)?.stop?.kind, 'completed');
});

Deno.test('catalog path filter excludes tools from snapshot', async () => {
  registerProfile(
    defineProfile({
      id: 'path_filter_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['web_only_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'path_filter_probe',
    path: 'cli',
    tools: gateTools('web_only_tool'),
    input: { text: 'x' },
  });
  assertEquals(generation.tools.gated.includes('web_only_tool'), false);
  assertEquals(generation.tools.executable.includes('web_only_tool'), false);
});

Deno.test('exposeToModel false omits data from model projection', () => {
  const registered = getTool('hidden_from_model_tool');
  assertEquals(registered?.type, 'function');
  if (registered?.type !== 'function') {
    return;
  }
  const projected = projectForModel(registered, { finding: 'done', secret: 'classified' });
  assertEquals(projected.data, undefined);
  assertEquals(projected.finding, 'Completed.');
});

Deno.test('formatToolResult sanitizes finding and includes data', () => {
  const text = formatToolResult({ finding: 'ok', data: { n: 1 } });
  assertEquals(text.includes('ok'), true);
  assertEquals(text.includes('"n":1'), true);
});

Deno.test('permission check runs before preflight', async () => {
  let preflightRan = false;
  registerTool(
    defineTool({
      type: 'function',
      name: 'permission_before_preflight_probe',
      description: 'Permission before preflight probe',
      category: 'test',
      access: 'read-write',
      paths: ['*'],
      loadTier: 'T0',
      permission: 'session_consent',
      input: z.object({}),
      output: z.object({ finding: z.string() }),
      preflight: () => {
        preflightRan = true;
      },
      handler: () => ({ finding: 'ran' }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 'permission_order_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['permission_before_preflight_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'permission_order_probe',
    name: 'permission_before_preflight_probe',
    input: {},
    tools: gateTools('permission_before_preflight_probe'),
  });
  assertEquals(preflightRan, false);
  assertEquals(
    events.findLast((e) => e.tool?.name === 'permission_before_preflight_probe')?.tool?.phase,
    'pause',
  );
});

Deno.test('defineTool requires loader tools to use loadTier T0', () => {
  assertThrows(
    () =>
      defineTool({
        type: 'loader',
        name: 'bad_loader',
        description: 'Invalid tier',
        category: 'test',
        access: 'read-write',
        paths: ['*'],
        loadTier: 'T2',
        permission: 'auto',
        input: z.object({ names: z.array(z.string()) }),
        output: z.object({ loaded: z.array(z.string()) }),
        resolve: () => ({ loaded: [] }),
      }),
    Error,
  );
});

Deno.test('loader promote rejects non-T2 tool ids', () => {
  registerProfile(
    defineProfile({
      id: 'promote_tier_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['load_tools', 'stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile('promote_tier_probe');
  const snapshot = resolveTurnTools(profile, {
    profile: 'promote_tier_probe',
    tools: gateTools('load_tools', 'stub_tool'),
    input: { text: 'x' },
  }, 'gemini35FlashLite');
  assertThrows(() => promoteLoadedTools(snapshot, ['stub_tool'], profile), Error);
});

Deno.test('toolLoader wires T1 function tools via prepareTurnToolSnapshot', async () => {
  const ContextualInput = z.object({ q: z.string() });
  registerTool(
    defineTool({
      type: 'function',
      name: 'contextual_lookup',
      description: 'Lookup when host selects it',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T1',
      permission: 'auto',
      input: ContextualInput,
      output: z.object({ finding: z.string() }),
      handler: (input) => ({ finding: `found ${(input as { q: string }).q}` }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 't1_loader_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['contextual_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const req = {
    profile: 't1_loader_probe',
    tools: gateTools('contextual_lookup'),
    input: { text: 'find my order' },
    toolLoader: () => ['contextual_lookup'],
  };
  const profile = getProfile('t1_loader_probe');
  const snapshot = await prepareTurnToolSnapshot(profile, req, 'gemini35FlashLite');
  assertEquals(snapshot.visible, ['contextual_lookup']);
});

Deno.test('invokeTool resume cannot bypass T2 not_loaded without promoted', async () => {
  registerProfile(
    defineProfile({
      id: 't2_resume_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_resume_probe',
    name: 'record_lookup',
    input: { q: 'secret' },
    resume: { value: true },
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_loaded');
});

Deno.test('invokeTool resume runs T2 when promoted ids are supplied', async () => {
  registerProfile(
    defineProfile({
      id: 't2_resume_promoted_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_resume_promoted_probe',
    name: 'record_lookup',
    input: { q: 'ok' },
    tools: gateTools('record_lookup'),
    promoted: ['record_lookup'],
    resume: { value: true },
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'record_lookup')?.tool?.phase, 'complete');
});

Deno.test('invokeTool wires T1 tools when toolLoader is provided', async () => {
  registerTool(
    defineTool({
      type: 'function',
      name: 'invoke_t1_probe',
      description: 'T1 invoke probe',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T1',
      permission: 'auto',
      input: z.object({ q: z.string() }),
      output: z.object({ finding: z.string() }),
      handler: (input) => ({ finding: `invoke ${(input as { q: string }).q}` }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 'invoke_t1_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['invoke_t1_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_t1_bot',
    name: 'invoke_t1_probe',
    input: { q: 'x' },
    tools: gateTools('invoke_t1_probe'),
    toolLoader: () => ['invoke_t1_probe'],
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'invoke_t1_probe')?.tool?.phase, 'complete');
});

Deno.test('empty resume object does not bypass turn gating or T2 load checks', async () => {
  registerProfile(
    defineProfile({
      id: 'empty_resume_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'empty_resume_probe',
    name: 'record_lookup',
    input: { q: 'x' },
    resume: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_gated');
});

Deno.test('loader output lists only ids actually promoted', async () => {
  registerTool(
    defineTool({
      type: 'function',
      name: 'ungated_t2_probe',
      description: 'T2 tool left ungated on purpose',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T2',
      permission: 'auto',
      input: z.object({}),
      output: z.object({ finding: z.string() }),
      handler: () => ({ finding: 'ungated' }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 'loader_output_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['load_tools', 'record_lookup', 'ungated_t2_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'loader_output_probe',
    name: 'load_tools',
    input: { names: ['record_lookup', 'ungated_t2_probe'] },
    tools: gateTools('load_tools', 'record_lookup'),
  });
  const complete = events.findLast((e) => e.tool?.name === 'load_tools' && e.tool?.phase === 'complete');
  assertEquals(complete?.tool?.output, { loaded: ['record_lookup'] });
});

Deno.test('path omitted excludes tools without wildcard paths', () => {
  registerProfile(
    defineProfile({
      id: 'path_default_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['web_only_tool', 'stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'path_default_probe',
    tools: gateTools('web_only_tool', 'stub_tool'),
    input: { text: 'x' },
  });
  assertEquals(generation.tools.gated.includes('web_only_tool'), false);
  assertEquals(generation.tools.gated.includes('stub_tool'), true);
});

Deno.test('T1 builtins stay off wire until toolLoader selects them', async () => {
  registerTool(
    defineTool({
      type: 'builtin',
      name: 'deferred_builtin_probe',
      description: 'Deferred builtin probe',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T1',
      permission: 'auto',
      wire: { interactions: 'deferred_probe' },
    }),
  );
  registerProfile(
    defineProfile({
      id: 't1_builtin_probe',
      model: {
        allow: ['gemini35FlashLite'],
        config: {
          gemini35FlashLite: {
            ...HOST_MODELS.gemini35FlashLite,
            builtInTools: ['deferred_builtin_probe'],
          },
        },
        maxSteps: 1,
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const req = {
    profile: 't1_builtin_probe',
    tools: gateTools('deferred_builtin_probe'),
    input: { text: 'x' },
    toolLoader: () => ['deferred_builtin_probe'],
  };
  const profile = getProfile('t1_builtin_probe');
  const snapshot = resolveTurnTools(profile, req, 'gemini35FlashLite');
  assertEquals(snapshot.builtins.includes('deferred_builtin_probe'), false);
  await expandTurnToolLoader(snapshot, profile, req);
  assertEquals(snapshot.builtins, ['deferred_builtin_probe']);
});

Deno.test('runTurn expands toolLoader before provider sees T1 tools', async () => {
  registerTool(
    defineTool({
      type: 'function',
      name: 'runturn_t1_probe',
      description: 'T1 runTurn probe',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T1',
      permission: 'auto',
      input: z.object({}),
      output: z.object({ finding: z.string() }),
      handler: () => ({ finding: 'runturn ok' }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 'runturn_t1_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['runturn_t1_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  let sawWire = false;
  const provider: ModelProvider = {
    async *complete(req) {
      sawWire = req.wireTools?.some((w) => w.name === 'runturn_t1_probe') ?? false;
      yield { type: 'text', text: 'done' };
    },
  };
  await collect(
    runTurn(
      {
        profile: 'runturn_t1_bot',
        tools: gateTools('runturn_t1_probe'),
        toolLoader: () => ['runturn_t1_probe'],
        input: { text: 'x' },
      },
      provider,
    ),
  );
  assertEquals(sawWire, true);
});

Deno.test('failure codes surface on invokeTool path', async () => {
  registerProfile(
    defineProfile({
      id: 'failure_codes_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['stub_tool', 'denied_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const invalidInput = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'stub_tool',
    input: { value: 'not-a-number' },
    tools: gateTools('stub_tool'),
  });
  assertEquals(
    invalidInput.findLast((e) => e.tool?.name === 'stub_tool')?.tool?.failure?.code,
    'invalid_input',
  );

  const notAllowed = await invokeRegisteredTool({
    profile: 'pinned',
    name: 'denied_tool',
    input: {},
    tools: gateTools('denied_tool'),
  });
  assertEquals(
    notAllowed.findLast((e) => e.tool?.name === 'denied_tool')?.tool?.failure?.code,
    'not_allowed',
  );

  const unknown = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'missing_tool_xyz',
    input: {},
    tools: gateTools('missing_tool_xyz'),
  });
  assertEquals(
    unknown.findLast((e) => e.tool?.name === 'missing_tool_xyz')?.tool?.failure?.code,
    'unknown_tool',
  );

  const unauthorized = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'denied_tool',
    input: {},
    tools: gateTools('denied_tool'),
  });
  assertEquals(
    unauthorized.findLast((e) => e.tool?.name === 'denied_tool')?.tool?.failure?.code,
    'not_authorized',
  );
});

Deno.test('permission granted alone does not resume interactive tools', async () => {
  registerTool(
    defineTool({
      type: 'function',
      name: 'interactive_resume_probe',
      description: 'Interactive resume probe',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T0',
      permission: 'auto',
      input: z.object({ prompt: z.string() }),
      output: z.object({ finding: z.string() }),
      interactive: {
        render: (input) => ({ kind: 'text', prompt: (input as { prompt: string }).prompt }),
      },
      handler: (_input, ctx) => ({ finding: String(ctx.resume?.value ?? 'missing') }),
    }),
  );
  registerProfile(
    defineProfile({
      id: 'interactive_resume_bot',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['interactive_resume_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const paused = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
    tools: gateTools('interactive_resume_probe'),
  });
  assertEquals(
    paused.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'pause',
  );

  const fakeResume = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
    tools: gateTools('interactive_resume_probe'),
    resume: { granted: true },
  });
  assertEquals(
    fakeResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'pause',
  );

  const realResume = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
    tools: gateTools('interactive_resume_probe'),
    resume: { value: 'picked' },
  });
  assertEquals(
    realResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'complete',
  );
  assertEquals(
    (realResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.output as {
      finding?: string;
    })?.finding,
    'picked',
  );
});

Deno.test('T2 tools are not visible until loader promotes them', () => {
  registerProfile(
    defineProfile({
      id: 't2_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['load_tools', 'record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 't2_probe',
    tools: gateTools('load_tools', 'record_lookup'),
    input: { text: 'x' },
  });
  assertEquals(generation.tools.visible, ['load_tools']);
  assertEquals(generation.tools.visible.includes('record_lookup'), false);
});

Deno.test('invokeTool can run loader tools with turn snapshot', async () => {
  registerProfile(
    defineProfile({
      id: 'invoke_loader_probe',
      model: { ...modelAllow('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['load_tools', 'record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_loader_probe',
    name: 'load_tools',
    input: { names: ['record_lookup'] },
    tools: gateTools('load_tools'),
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'load_tools')?.tool?.phase, 'complete');
});
