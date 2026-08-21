import type { Profile, TurnFixRequest, TurnHistoryMessage } from '../types.ts';

const MAX_FIX_HISTORY_EXCHANGES = 2;
const MAX_FIX_HISTORY_MESSAGES = MAX_FIX_HISTORY_EXCHANGES * 2;

function scopeHistory(history: TurnHistoryMessage[] | undefined): TurnHistoryMessage[] {
  if (!history || history.length === 0) {
    return [];
  }
  return history.slice(-MAX_FIX_HISTORY_MESSAGES);
}

function formatHistoryBlock(messages: TurnHistoryMessage[]): string {
  if (messages.length === 0) {
    return '';
  }
  const lines = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  return `### RECENT CONVERSATION CONTEXT (LAST ${messages.length} TURNS)\n${lines.join('\n')}\n\n`;
}

function synthesizeFixPrompt(args: {
  profile: Profile;
  fix: TurnFixRequest;
  history?: TurnHistoryMessage[];
}): string {
  const { profile, fix, history } = args;
  const guidance =
    fix.guidance ||
    profile.outputs.validation?.repairGuidance ||
    'Fix the errors indicated above. Ensure the emitted artifact is syntactically valid and well-formed.';

  const historyBlock = formatHistoryBlock(scopeHistory(history));

  let prompt = `## ARTIFACT REPAIR REQUEST\n\n`;
  prompt += `The previous artifact generated has validation/compilation errors and must be corrected.\n\n`;

  prompt += `### BROKEN ARTIFACT SOURCE\n\`\`\`\n${fix.artifact.trim()}\n\`\`\`\n\n`;
  prompt += `### VALIDATION / COMPILER ERROR\n${fix.error.trim()}\n\n`;

  if (guidance.trim()) {
    prompt += `### REPAIR GUIDANCE & RULES\n${guidance.trim()}\n\n`;
  }

  if (historyBlock) {
    prompt += historyBlock;
  }

  prompt += `### INSTRUCTIONS\n`;
  prompt += `1. Carefully inspect the broken artifact source and error message.\n`;
  prompt += `2. Follow the repair rules to resolve the issue.\n`;
  prompt += `3. Return the corrected structured output. Your output MUST resolve the error above.`;

  return prompt;
}

export { MAX_FIX_HISTORY_EXCHANGES, scopeHistory, synthesizeFixPrompt };
