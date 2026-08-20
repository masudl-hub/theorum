import { asRecord } from './record.ts';

function eventName(row: Record<string, unknown>): string {
  return String(row.event_type ?? row.eventType ?? '');
}

function completedInteraction(gemini: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(gemini)) {
    return undefined;
  }
  for (let i = gemini.length - 1; i >= 0; i -= 1) {
    const row = asRecord(gemini[i]);
    if (row) {
      const name = eventName(row);
      if (name === 'interaction.completed' || name === 'interaction.complete') {
        return asRecord(row.interaction) ?? row;
      }
    }
  }
  return undefined;
}

function httpStatus(gemini: unknown): unknown {
  if (!Array.isArray(gemini)) {
    return undefined;
  }
  for (const item of gemini) {
    const row = asRecord(item);
    if (row && eventName(row) === 'http_response') {
      return row.status;
    }
  }
  return undefined;
}

export { completedInteraction, httpStatus };
