import type { ProviderCompleteRequest, ResolvedGeneration } from '../types.ts';

/** Build the provider request projection shared by execution and tracing. */
function providerCompleteRequest(
  generation: ResolvedGeneration,
  system: string,
): ProviderCompleteRequest {
  return {
    model: generation.model,
    apiId: generation.apiId,
    openRouterId: generation.openRouterId,
    previousInteractionId: generation.previousInteractionId,
    store: generation.store,
    stream: generation.stream,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system,
    input: generation.input,
    history: generation.history,
    interactionOnlyInput: generation.interactionOnlyInput,
    dynamicTools: generation.dynamicTools,
    dynamicToolLoader: generation.dynamicToolLoader,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    geminiBucket: generation.geminiBucket,
  };
}

export { providerCompleteRequest };
