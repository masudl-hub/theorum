import '../fixtures/test-host.ts';
import { isAbortError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

Deno.test('runTurn throws AbortError when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider: ModelProvider = {
    complete: () => {
      throw new Error('provider should not run');
    },
  };
  let threw: unknown;
  try {
    await collect(
      runTurn({ profile: 'chat', input: { text: 'hi' }, signal: controller.signal }, provider),
    );
  } catch (err) {
    threw = err;
  }
  assertEquals(isAbortError(threw), true);
});

Deno.test('runTurn cancels an in-flight provider when signal aborts', async () => {
  const controller = new AbortController();
  const into: TraceRecord[] = [];
  let sawAbort = false;
  const provider: ModelProvider = {
    async *complete(req: ProviderCompleteRequest) {
      await new Promise<void>((_resolve, reject) => {
        const { signal } = req;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      });
    },
  };

  let threw: unknown;
  try {
    await collect(
      runTurn(
        { profile: 'chat', input: { text: 'hi' }, signal: controller.signal },
        provider,
        memorySink(into),
      ),
    );
  } catch (err) {
    threw = err;
  }
  assertEquals(isAbortError(threw), true);
  assertEquals(sawAbort, true);
  assertEquals(into[0]?.cancelled, true);
  assertEquals(into[0]?.ok, false);
});
