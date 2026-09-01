import { publicError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import type { ModelProvider, Profile, ResolvedGeneration, TurnEvent } from '../../types.ts';
import { eventHasCanary, redactCanary } from '../boundary.ts';
import { dispatchModelTool } from './tools.ts';

function systemFromProfile(profile: Profile, role: string): string {
  const { identity } = profile;
  const { systemByRole, system } = identity;
  if (systemByRole) {
    const byRole = systemByRole[role];
    if (byRole) {
      return byRole;
    }
  }
  if (system) {
    return system;
  }
  return '';
}

function* interceptProviderTool(
  event: TurnEvent,
  profile: Profile,
  generation: ResolvedGeneration,
): Generator<TurnEvent> {
  const tool = event.tool;
  if (!tool) {
    return;
  }
  const isDynamic = generation.dynamicTools?.some((d) => d.name === tool.name);
  if (isDynamic) {
    yield event;
  } else {
    for (const item of dispatchModelTool(profile, event, generation.custom)) {
      yield item;
    }
  }
}

function shouldSkipStreamEvent(event: TurnEvent, profile: Profile): boolean {
  return event.type === 'thought' && profile.outputs.streaming?.streamThoughts === false;
}

function* processNormalEvent(
  event: TurnEvent,
  profile: Profile,
  generation: ResolvedGeneration,
): Generator<TurnEvent> {
  if (event.type === 'tool') {
    yield* interceptProviderTool(event, profile, generation);
  } else if (event.type === 'error') {
    const internal = event.errorInternal ?? event.error ?? '';
    yield {
      type: 'error',
      error: publicError(event.error ?? internal),
      ...(internal ? { errorInternal: internal } : {}),
    };
  } else {
    yield event;
  }
}

async function* yieldProviderEvents(args: {
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  signal?: AbortSignal;
}): AsyncGenerator<TurnEvent> {
  const { profile, generation, system, provider, upstream, signal } = args;
  const { canary } = generation;
  throwIfAborted(signal);
  for await (const event of provider.complete({
    ...providerCompleteRequest(generation, system),
    signal,
    tapUpstream: (row) => {
      upstream.push(row);
    },
  })) {
    throwIfAborted(signal);
    if (canary && eventHasCanary(event, canary)) {
      yield redactCanary(event, canary);
      yield toErrorEvent('canary leaked');
      return;
    }
    yield* processNormalEvent(event, profile, generation);
  }
}

export { shouldSkipStreamEvent, systemFromProfile, yieldProviderEvents };
