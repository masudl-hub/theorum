import { assertThrows } from '@std/assert';
import {
  assertEquals as kernelAssertEquals,
  assertStringIncludes as kernelAssertStringIncludes,
  assertThrows as kernelAssertThrows,
} from '../../src/kernel/engine/assert.ts';

Deno.test('kernel engine assert utilities test all success and failure branches', () => {
  // assertEquals
  kernelAssertEquals({ a: 1 }, { a: 1 });
  assertThrows(() => kernelAssertEquals({ a: 1 }, { a: 2 }), Error, 'assertEquals failed');

  // assertStringIncludes
  kernelAssertStringIncludes('hello world', 'world');
  assertThrows(
    () => kernelAssertStringIncludes('hello world', 'planet'),
    Error,
    'assertStringIncludes failed',
  );

  // assertThrows - success
  kernelAssertThrows(() => {
    throw new TypeError('invalid type');
  }, TypeError);

  // assertThrows - did not throw
  assertThrows(
    () => {
      kernelAssertThrows(() => {
        // no-op
      }, Error);
    },
    Error,
    'assertThrows failed: expected Error',
  );

  // assertThrows - threw unexpected error type (should rethrow)
  assertThrows(
    () => {
      kernelAssertThrows(() => {
        throw new RangeError('out of range');
      }, TypeError);
    },
    RangeError,
    'out of range',
  );
});
