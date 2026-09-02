/**
 * Tool projection for host/UI inspection.
 *
 * @module
 */

import type { Profile, ToolId } from '../types.ts';
import { getTool } from './registry.ts';
import type { RegisteredTool } from './types.ts';

function projectTool(name: ToolId): RegisteredTool | { name: ToolId; missing: true } {
  const tool = getTool(name);
  if (!tool) {
    return { name, missing: true };
  }
  return tool;
}

function builtInToolIds(profile: Profile): ToolId[] {
  const seen = new Set<ToolId>();
  for (const modelId of profile.model.allow) {
    const spec = profile.model.config[modelId];
    for (const id of spec.builtInTools) {
      seen.add(id);
    }
  }
  return [...seen];
}

/** Custom + builtin tool ids declared on a profile (union across models). */
function listProfileToolIds(profile: Profile): ToolId[] {
  return [...profile.tools.allow, ...builtInToolIds(profile)];
}

function projectTools(profile: Profile): Array<RegisteredTool | { name: ToolId; missing: true }> {
  const ids = listProfileToolIds(profile);
  return ids.map((name) => projectTool(name));
}

export { listProfileToolIds, projectTools };
