import '../fixtures/enable-test-internals.ts';
import '../fixtures/test-host.ts';
import '../../src/providers/google/interactions/stream.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { FunctionToolDef, TurnToolSnapshot } from '../../src/kernel/tools/types.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { testInternals } from '../fixtures/testInternals.js';

type InternalsFn = (...args: unknown[]) => unknown;
type ToolPhaseEvent = {
  tool: {
    phase: string;
    data?: unknown;
    step?: { name: string };
    artifact?: { id: string };
    warning?: { code: string };
  };
};
type NamedWire = { name: string };
type MediaEvent = { type?: string; media: { mimeType: string } };
type StreamFold = { sawStreamedMedia?: boolean; text?: string };
type PromoteResult = { promoted: string[] };
type FailureInfo = { message?: string; code?: string };

function asValue<T>(value: unknown): T {
  return value as T;
}

function asIter<T>(value: unknown): T[] {
  return [...(value as Iterable<T>)];
}

const execute = testInternals('kernel-tools-execute') as Record<string, InternalsFn>;
const resolve = testInternals('kernel-tools-resolve') as Record<string, InternalsFn>;
const stream = testInternals('google-interactions') as Record<string, InternalsFn>;

const base = { name: 'probe', callId: 'c1', arguments: {} };

Deno.test('tools mutation helpers classify resume, pauses, and permissions precisely', () => {
  assertEquals(execute.isResumeContinuation(undefined), false);
  assertEquals(execute.isResumeContinuation({}), false);
  assertEquals(execute.isResumeContinuation({ granted: true }), true);
  assertEquals(execute.isResumeContinuation({ value: 0 }), true);
  assertEquals(execute.isResumeContinuation({ value: undefined, granted: false }), false);

  assertEquals(execute.isToolPause({ kind: 'interactive', tool: 'probe', input: {} }), true);
  assertEquals(execute.isToolPause({ kind: 'confirmation', tool: 'probe', input: {} }), true);
  assertEquals(execute.isToolPause({ kind: 'permission', tool: 'probe', input: {} }), true);
  assertEquals(execute.isToolPause({ code: 'x', message: 'failure' }), false);

  assertEquals(execute.permissionGranted('probe', undefined), false);
  assertEquals(execute.permissionGranted('probe', []), false);
  assertEquals(execute.permissionGranted('probe', ['probe']), true);
  assertEquals(execute.permissionGranted('probe', ['*']), true);
  assertEquals(execute.permissionGranted('probe', ['other']), false);

  assertEquals(execute.checkPermission('probe', 'auto'), null);
  assertEquals(execute.checkPermission('probe', 'always_confirm', ['probe']), {
    kind: 'permission',
    tool: 'probe',
    permission: 'always_confirm',
    input: {},
  });
  assertEquals(
    execute.checkPermission('probe', 'always_confirm', undefined, { granted: true }),
    null,
  );
  assertEquals(execute.checkPermission('probe', 'session_consent', ['probe']), null);
  assertEquals(
    asValue<{ kind?: string } | null | undefined>(
      execute.checkPermission('probe', 'session_consent', undefined),
    )?.kind,
    'permission',
  );
});

Deno.test('tools mutation helpers preserve side-event payloads', () => {
  const events = ['progress', 'trace', 'artifact', 'warning'].flatMap((kind) => {
    const event =
      kind === 'progress'
        ? { kind, data: { n: 1 } }
        : kind === 'trace'
          ? { kind, step: { name: 's', kind: 'test', status: 'ok' } }
          : kind === 'artifact'
            ? { kind, artifact: { id: 'a' } }
            : { kind, warning: { code: 'w', message: 'slow' } };
    return asIter<ToolPhaseEvent>(execute.yieldHandlerSideEvent(base, event));
  });
  assertEquals(
    events.map((event) => event.tool.phase),
    ['progress', 'trace', 'artifact', 'warning'],
  );
  assertEquals(events[0]?.tool.data, { n: 1 });
  assertEquals(events[1]?.tool.step?.name, 's');
  assertEquals(events[2]?.tool.artifact?.id, 'a');
  assertEquals(events[3]?.tool.warning?.code, 'w');
});

Deno.test('tools mutation helpers project and format model results exactly', () => {
  const visible = { exposeToModel: true } as FunctionToolDef;
  const hidden = { exposeToModel: false } as FunctionToolDef;
  assertEquals(execute.projectForModel(hidden, { finding: 'secret' }), { finding: 'Completed.' });
  assertEquals(execute.projectForModel(visible, { finding: 'hello' }), {
    finding: 'hello',
    data: { finding: 'hello' },
  });
  assertEquals(execute.projectForModel(visible, { value: 2 }), {
    finding: '{"value":2}',
    data: { value: 2 },
  });
  assertEquals(execute.formatToolResult({ finding: 'ok' }), 'ok');
  assertEquals(execute.formatToolResult({ finding: 'ok', data: { n: 1 } }), 'ok\n{"n":1}');
  assertEquals(execute.formatToolFailureForModel({ code: 'bad', message: 'no' }), {
    finding: 'Tool error (bad): no',
    data: { ok: false, code: 'bad', message: 'no' },
  });
  assertEquals(
    execute.formatToolFailureForModel({ code: 'bad', message: 'no', details: { field: 'x' } }),
    {
      finding: 'Tool error (bad): no',
      data: { ok: false, code: 'bad', message: 'no', details: { field: 'x' } },
    },
  );
});

Deno.test('tools mutation helpers validate loaded ids and sanitize nested input', () => {
  assertEquals(
    execute.notLoadedMessage({ name: 'probe', loadTier: 'T0' }),
    "Tool 'probe' is not visible this turn",
  );
  assertEquals(
    execute.notLoadedMessage({ name: 'one', loadTier: 'T1' }),
    "Tool 'one' is not wired — profile.tools.t1Policy must select it",
  );
  assertEquals(
    execute.notLoadedMessage({ name: 'two', loadTier: 'T2' }),
    "Tool 'two' is not loaded — run profile.tools.t2Loader first",
  );
  assertEquals(execute.extractLoadedIds(null), undefined);
  assertEquals(execute.extractLoadedIds([]), undefined);
  assertEquals(execute.extractLoadedIds({ loaded: [] }), []);
  assertEquals(execute.extractLoadedIds({ loaded: ['a', 'b'] }), ['a', 'b']);
  assertEquals(execute.extractLoadedIds({ loaded: ['a', 2] }), undefined);
  const polluted = JSON.parse(
    '{"safe":{"x":1},"__proto__":{"polluted":true},"constructor":{"x":2},"prototype":{"x":3}}',
  );
  assertEquals(execute.plainToolInput(polluted), { safe: { x: 1 } });
  assertEquals(execute.plainToolInput([null, 2, { x: 'y' }]), [null, 2, { x: 'y' }]);
  assertEquals(execute.plainToolInput('x'), 'x');
});

Deno.test('tools mutation helpers filter paths, wire tools, and clone snapshots', () => {
  assertEquals(resolve.pathMatches(['*'], undefined), true);
  assertEquals(resolve.pathMatches(['web'], undefined), false);
  assertEquals(resolve.pathMatches(['web'], 'web'), true);
  assertEquals(resolve.pathMatches(['web'], 'cli'), false);
  assertEquals(resolve.initialVisible(['stub_tool', 'record_lookup']), ['stub_tool']);
  assertEquals(resolve.initialBuiltins(['googleSearch']), ['googleSearch']);
  const snapshot: TurnToolSnapshot = {
    builtins: [],
    gated: ['stub_tool'],
    visible: ['stub_tool'],
    executable: ['stub_tool'],
    path: 'web',
    sessionPermissions: ['x'],
    wire: [],
  };
  const cloned = asValue<TurnToolSnapshot>(resolve.cloneTurnToolSnapshot(snapshot));
  cloned.visible.push('changed');
  cloned.sessionPermissions?.push('changed');
  assertEquals(snapshot.visible, ['stub_tool']);
  assertEquals(snapshot.sessionPermissions, ['x']);
});

Deno.test('tools mutation coverage exercises resolver filtering and builtin promotion', () => {
  assertEquals(resolve.applyBuiltinMutualExclusions(['googleSearch', 'googleMaps']), [
    'googleSearch',
    'googleMaps',
  ]);
  assertEquals(
    resolve.resolveAllowedCustomToolIds(
      { tools: { allow: ['stub_tool', 'record_lookup', 'googleSearch', 'missing'] } },
      { path: 'web' },
    ),
    ['stub_tool', 'record_lookup'],
  );
  assertEquals(
    resolve.resolveModelBuiltinIds(
      { model: { config: { m: { builtInTools: ['googleSearch', 'stub_tool', 'missing'] } } } },
      { path: 'web' },
      'm',
    ),
    ['googleSearch'],
  );
  assertEquals(
    resolve.resolveModelBuiltinIds({ model: { config: {} } }, { path: 'web' }, 'missing'),
    [],
  );
  assertEquals(asValue<NamedWire>(resolve.wireForTool('stub_tool')).name, 'stub_tool');
  assertEquals(resolve.wireForTool('googleSearch'), undefined);
  assertEquals(resolve.wireForTool('missing'), undefined);
  assertEquals(
    asValue<NamedWire[]>(resolve.buildWire(['stub_tool', 'googleSearch', 'missing'])).map(
      (wire) => wire.name,
    ),
    ['stub_tool'],
  );

  const state: TurnToolSnapshot = {
    builtins: ['googleSearch'],
    gated: ['googleSearch', 'googleMaps'],
    visible: [],
    executable: [],
    wire: [],
  };
  resolve.promoteBuiltin(state, 'googleSearch');
  resolve.promoteBuiltin(state, 'googleMaps');
  assertEquals(state.builtins, ['googleSearch', 'googleMaps']);
  resolve.promoteBuiltin(state, 'stub_tool');
  assertEquals(state.builtins, ['googleSearch', 'googleMaps']);
  assertEquals(
    asValue<FailureInfo | undefined>(
      resolve.promotionFailure('stub_tool', { tools: { allow: ['stub_tool'] } }),
    )?.message,
    "tools.t2Loader attempted to promote tool 'stub_tool' with loadTier 'T0' — only T2 tools may be promoted",
  );
  assertEquals(
    asValue<FailureInfo | undefined>(resolve.promotionFailure('missing', { tools: { allow: [] } }))
      ?.code,
    'invalid_output',
  );
  assertEquals(
    resolve.promotionFailure('record_lookup', { tools: { allow: ['record_lookup'] } }),
    undefined,
  );
});

Deno.test('tools mutation helpers reject invalid promotion and preserve state atomically', () => {
  const profile = { tools: { allow: ['record_lookup'] } } as Profile;
  const state: TurnToolSnapshot = {
    builtins: [],
    gated: ['record_lookup'],
    visible: [],
    executable: [],
    path: 'web',
    wire: [],
  };
  for (const id of ['__proto__', 'constructor', 'prototype', 'missing', 'stub_tool']) {
    const result = asValue<PromoteResult>(resolve.promoteLoadedTools(state, [id], profile));
    assertEquals(result.promoted, []);
    assertEquals(state.visible, []);
  }
  const result = asValue<PromoteResult>(
    resolve.promoteLoadedTools(state, ['record_lookup'], profile),
  );
  assertEquals(result.promoted, ['record_lookup']);
  assertEquals(state.visible, ['record_lookup']);
  assertEquals(state.executable, ['record_lookup']);
});

Deno.test('tools mutation coverage exercises Interactions media and API error helpers', async () => {
  assertEquals(stream.readData({ data: 'abc' }), 'abc');
  assertEquals(stream.readData({ data: '' }), undefined);
  assertEquals(stream.readData({ data: 1 }), undefined);
  assertEquals(stream.readMime({ mime_type: 'image/png' }), 'image/png');
  assertEquals(stream.readMime({ mimeType: 'audio/wav' }), 'audio/wav');
  assertEquals(stream.readMime({ mimeType: '' }), undefined);

  const media = asIter<MediaEvent>(
    stream.scanMediaParts([
      null,
      { type: 'image', data: 'a', mime_type: 'image/png' },
      { type: 'audio', data: 'b', mimeType: 'audio/mpeg' },
      { type: 'media', data: 'c', mimeType: 'video/mp4' },
      { type: 'video', data: 'd', mimeType: 'video/mp4' },
      { type: 'text', data: 'ignored' },
    ]),
  );
  assertEquals(media.length, 4);
  assertEquals(
    media.map((event) => event.media.mimeType),
    ['image/png', 'audio/mpeg', 'video/mp4', 'video/mp4'],
  );
  assertEquals(asIter(stream.scanMediaParts({})), []);
  assertEquals(
    asIter(stream.scanInteractionsMedia({ steps: [{ content: [{ type: 'image', data: 'x' }] }] }))
      .length,
    1,
  );
  assertEquals(asIter(stream.scanInteractionsMedia({ steps: [null, 2] })), []);

  assertEquals(stream.readApiErrorMessage({}), null);
  assertEquals(stream.readApiErrorMessage({ error: null }), null);
  assertEquals(stream.readApiErrorMessage({ error: { message: 'bad' } }), 'bad');
  assertEquals(
    stream.readApiErrorMessage({ error: { message: 'bad', status: 'INVALID_ARGUMENT' } }),
    'INVALID_ARGUMENT: bad',
  );
  assertEquals(stream.readApiErrorMessage({ error: { message: '' } }), 'Gemini returned an error.');
  assertEquals(stream.readApiErrorMessage({ error: { message: 4 } }), 'Gemini returned an error.');
  assertEquals(await stream.readNonOkErrorMessage(new Response('', { status: 503 })), 'HTTP 503');
  assertEquals(
    await stream.readNonOkErrorMessage(new Response('not json', { status: 400 })),
    'Gemini HTTP 400: not json',
  );
  assertEquals(
    await stream.readNonOkErrorMessage(
      new Response('{"error":{"message":"bad"}}', { status: 400 }),
    ),
    'bad',
  );
  assertEquals(
    await stream.readNonOkErrorMessage(new Response('{"error":{}}', { status: 400 })),
    'Gemini returned an error.',
  );
});

Deno.test('tools mutation coverage distinguishes voice synthesis conditions', () => {
  const plain = { text: 'hello', speech: undefined };
  const voice = { text: 'hello', speech: { voice: 'Kore', format: 'pcm' } };
  const empty = { text: '', speech: { voice: 'Kore', format: 'pcm' } };
  const mediaFold = asValue<StreamFold>(stream.newStreamFold());
  mediaFold.sawStreamedMedia = true;
  const textFold = asValue<StreamFold>(stream.newStreamFold());
  textFold.text = 'hello';
  assertEquals(stream.isVoiceProfile(plain), false);
  assertEquals(stream.isVoiceProfile(voice), true);
  assertEquals(stream.shouldSynthesizeAudio(plain, stream.newStreamFold()), false);
  assertEquals(stream.shouldSynthesizeAudio(voice, textFold), true);
  assertEquals(stream.shouldSynthesizeAudio(empty, stream.newStreamFold()), false);
  assertEquals(stream.shouldSynthesizeAudio(voice, mediaFold), false);
  assertEquals(asIter(stream.synthesizeVoiceAudio(stream.newStreamFold())).length, 1);
  const fold = asValue<StreamFold>(stream.newStreamFold());
  fold.text = 'hello';
  const audio = asIter<MediaEvent>(stream.synthesizeVoiceAudio(fold));
  assertEquals(audio[0]?.type, 'media');
  assertEquals(audio[0]?.media.mimeType, 'audio/wav');
});
