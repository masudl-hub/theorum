import { OMIT_CANARY } from './boundary.ts';
import { mapStrings } from './tree.ts';

const HEX_PAD = 2;
const HEX_RADIX = 16;

function hexSha256(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(HEX_RADIX).padStart(HEX_PAD, '0')).join('');
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexSha256(new Uint8Array(buf));
}

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

export { sha256, tapeGemini };
