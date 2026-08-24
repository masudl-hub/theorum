import { OMIT_CANARY } from '../kernel/engine/boundary.ts';
import { sha256 } from '../kernel/engine/hash.ts';
import { mapStrings } from '../kernel/engine/tree.ts';

function isImageBlob(rec: Record<string, unknown>): boolean {
  if (rec.type === 'image' || rec.type === 'media') {
    return true;
  }
  if (typeof rec.mimeType === 'string' || typeof rec.mime_type === 'string') {
    return true;
  }
  return false;
}

async function scrubEntry(
  rec: Record<string, unknown>,
  key: string,
  nested: unknown,
): Promise<[string, unknown]> {
  if (key === 'data' && typeof nested === 'string' && isImageBlob(rec)) {
    return [key, await sha256(nested)];
  }
  return [key, await scrubGemini(nested)];
}

function scrubRecord(rec: Record<string, unknown>): Promise<Record<string, unknown>> {
  return Promise.all(Object.entries(rec).map(([key, nested]) => scrubEntry(rec, key, nested))).then(
    (pairs) => {
      const out = Object.fromEntries(pairs);
      if (typeof rec.data === 'string' && isImageBlob(rec)) {
        out.dataKind = 'sha256';
      }
      return out;
    },
  );
}

function scrubGemini(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => scrubGemini(item)));
  }
  if (value && typeof value === 'object') {
    return scrubRecord(value as Record<string, unknown>);
  }
  return Promise.resolve(value);
}

function redactCanaryInTree(value: unknown, canary: string): unknown {
  if (!canary) {
    return value;
  }
  return mapStrings(value, (text) => text.replaceAll(canary, OMIT_CANARY));
}

async function tapeGemini(value: unknown, canary: string): Promise<unknown> {
  return redactCanaryInTree(await scrubGemini(value), canary);
}

export { tapeGemini };
