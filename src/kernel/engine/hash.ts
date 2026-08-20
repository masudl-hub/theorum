const HEX_PAD = 2;
const HEX_RADIX = 16;

function hexSha256(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(HEX_RADIX).padStart(HEX_PAD, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexSha256(new Uint8Array(buf));
}
