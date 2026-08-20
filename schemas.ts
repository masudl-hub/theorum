import { TheorumError } from './error.ts';
import type { StructuredSpec } from './types.ts';

const schemas = new Map<string, StructuredSpec>();

function registerStructured(id: string, spec: StructuredSpec): void {
  schemas.set(id, spec);
}

function getStructured(id: string): StructuredSpec {
  const spec = schemas.get(id);
  if (!spec) {
    throw new TheorumError(`Unknown structured schema '${id}'`);
  }
  return spec;
}

export { getStructured, registerStructured };
