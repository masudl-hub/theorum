type ErrorConstructor = new (message?: string) => Error;

function assertEquals(left: unknown, right: unknown): void {
  const same = JSON.stringify(left) === JSON.stringify(right);
  if (!same) {
    throw new Error(`assertEquals failed: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`assertStringIncludes failed: "${actual}" does not include "${expected}"`);
  }
}

function assertThrows(fn: () => unknown, ctor: ErrorConstructor): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ctor) {
      return;
    }
    throw err;
  }
  throw new Error(`assertThrows failed: expected ${ctor.name}`);
}

export type { ErrorConstructor };
export { assertEquals, assertStringIncludes, assertThrows };
