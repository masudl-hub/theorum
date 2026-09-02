/**
 * Process-local tool registry.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { defineTool } from './define.ts';
import type { RegisteredTool, ToolDefinitionInput } from './types.ts';

const tools = new Map<string, RegisteredTool>();

/** Register or replace a tool definition. */
function registerTool(def: ToolDefinitionInput): RegisteredTool {
  const normalized = defineTool(def);
  tools.set(normalized.name, normalized);
  return normalized;
}

/** Register several tools in order. */
function registerTools(defs: ToolDefinitionInput[]): RegisteredTool[] {
  return defs.map((def) => registerTool(def));
}

function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

function requireTool(name: string): RegisteredTool {
  const tool = getTool(name);
  if (!tool) {
    throw new TheorumError(`Tool '${name}' is not registered`);
  }
  return tool;
}

function hasTool(name: string): boolean {
  return tools.has(name);
}

function listTools(): RegisteredTool[] {
  return [...tools.values()];
}

function listBuiltinIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'builtin')
    .map((t) => t.name);
}

function listFunctionIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'function')
    .map((t) => t.name);
}

function resetTools(): void {
  tools.clear();
}

export {
  getTool,
  hasTool,
  listBuiltinIds,
  listFunctionIds,
  listTools,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
};
