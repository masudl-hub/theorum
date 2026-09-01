import '../../fixtures/test-host.ts';
import { resolveTurn } from '../../../src/kernel/registry/resolve.ts';
import { buildRecord } from '../../../src/observability/trace-record.ts';

console.log('PHASE:imported');

const { generation } = resolveTurn({ profile: 'chat', input: { text: 'probe' } });
const base = {
  req: { profile: 'chat', input: { text: 'probe' } },
  events: [{ type: 'text' as const, text: 'ok' }],
  started: Date.now(),
  system: 'probe system',
  generation,
  upstreamLog: [],
};

await buildRecord({ ...base, protocol: 'openAi' });

console.log('PHASE:openAi-record');

await buildRecord({ ...base, protocol: 'geminiInteractions' });

console.log('PHASE:gemini-record');
console.log('PROBE_DONE');
