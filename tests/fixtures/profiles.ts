import type { Profile, ProfileModelSpec, Protocol, Provider } from '../../src/kernel/types.ts';

/** Minimal typed profile for provider / probe tests (no casts). */
export function stubProfile(opts: {
  protocol: Protocol;
  provider: Provider;
  role?: 'chat' | 'speech' | 'image';
  id?: string;
}): Profile {
  const role = opts.role ?? 'chat';
  const outputs =
    role === 'speech'
      ? { structured: null, speech: { voice: 'Kore', format: 'pcm' as const } }
      : role === 'image'
        ? {
            structured: null,
            image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/png' },
          }
        : { structured: null };

  const model: ProfileModelSpec = {
    protocol: opts.protocol,
    provider: opts.provider,
    allow: [],
    config: {},
  };

  return {
    id: opts.id ?? 'test-profile',
    identity: { handle: opts.id ?? 'test' },
    model,
    tools: { allow: [] },
    inputs: { text: true },
    outputs,
    guardrails: {
      canary: true,
      sanitizeInput: true,
      redactSensitive: true,
      quota: { perDay: 1 },
    },
  };
}
