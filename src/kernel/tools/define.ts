/**
 * Tool definition normalizer.
 *
 * @module
 */

import type { z } from 'zod';
import { TheorumError } from '../../guardrails/error.ts';
import { jsonSchemaFromZod, validateToolInputSchema, validateToolOutputSchema } from './schema.ts';
import type {
  BuiltinToolDef,
  FunctionToolDef,
  LoaderToolDef,
  RegisteredTool,
  ToolDefinitionInput,
} from './types.ts';

function normalizeBuiltin(def: BuiltinToolDef): BuiltinToolDef {
  return { ...def };
}

function isStreamHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    Object.prototype.toString.call(handler) === '[object AsyncGeneratorFunction]'
  );
}

function normalizeFunction(
  def: Omit<FunctionToolDef, 'inputSchema' | 'outputSchema' | 'handlerStreams'> & {
    input: z.ZodType;
    output: z.ZodType;
  },
): FunctionToolDef {
  const inputSchema = jsonSchemaFromZod(def.input);
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output);
  validateToolOutputSchema(outputSchema);
  return {
    ...def,
    inputSchema,
    outputSchema,
    handlerStreams: isStreamHandler(def.handler),
  };
}

function normalizeLoader(
  def: Omit<LoaderToolDef, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType;
    output: z.ZodType;
  },
): LoaderToolDef {
  if (def.loadTier !== 'T0') {
    throw new TheorumError(
      `Loader tool '${def.name}' must use loadTier 'T0' — loaders unlock T2 tools and must be wired at turn start`,
    );
  }
  const inputSchema = jsonSchemaFromZod(def.input);
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output);
  validateToolOutputSchema(outputSchema);
  return {
    ...def,
    inputSchema,
    outputSchema,
  };
}

/** Normalize and validate a tool definition before registration. */
function defineTool(def: ToolDefinitionInput): RegisteredTool {
  if (def.type === 'builtin') {
    return normalizeBuiltin(def);
  }
  if (def.type === 'loader') {
    return normalizeLoader(def);
  }
  return normalizeFunction(def);
}

export { defineTool };
