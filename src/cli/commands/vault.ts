import { vaultFromEnv } from '../../guardrails/keys.ts';
import { resolveOpenRouterApiKey } from '../../providers/openrouter.ts';

function maskKey(key?: string): string {
  if (!key) return '(not set)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function vaultStatusCommand(): void {
  const vault = vaultFromEnv();
  const openRouterKey = resolveOpenRouterApiKey();
  const smokeKey = Deno.env.get('SMOKE_GEMINI_API_KEY');

  console.log('\n Theorum Key Vault Status:');
  console.log('='.repeat(70));
  console.log(
    ` • STUDIO Bucket:    ${maskKey(vault.studio).padEnd(24)} (ENV: GEMINI_API_KEY_STUDIO)`,
  );
  console.log(
    ` • PLANNER Bucket:   ${maskKey(vault.planner).padEnd(24)} (ENV: GEMINI_API_KEY_PLANNER)`,
  );
  console.log(
    ` • PORTFOLIO Bucket: ${maskKey(vault.portfolio).padEnd(24)} (ENV: GEMINI_API_KEY_PORTFOLIO)`,
  );
  console.log(` • PAID / OVERFLOW:  ${maskKey(vault.paid).padEnd(24)} (ENV: GEMINI_API_KEY)`);
  console.log(` • SMOKE Bucket:     ${maskKey(smokeKey).padEnd(24)} (ENV: SMOKE_GEMINI_API_KEY)`);
  console.log(
    ` • OPENROUTER:       ${maskKey(openRouterKey).padEnd(24)} (ENV: OPENROUTER_API_KEY)`,
  );
  console.log(`${'='.repeat(70)}\n`);
}

export async function vaultPingCommand(): Promise<void> {
  const vault = vaultFromEnv();
  const openRouterKey = resolveOpenRouterApiKey();

  console.log('\n Probing Provider Endpoints...');
  console.log('='.repeat(70));

  const entries: Array<{ bucket: string; key?: string; isGoogle?: boolean }> = [
    { bucket: 'studio (GEMINI_API_KEY_STUDIO)', key: vault.studio, isGoogle: true },
    { bucket: 'planner (GEMINI_API_KEY_PLANNER)', key: vault.planner, isGoogle: true },
    { bucket: 'portfolio (GEMINI_API_KEY_PORTFOLIO)', key: vault.portfolio, isGoogle: true },
    { bucket: 'paid (GEMINI_API_KEY)', key: vault.paid, isGoogle: true },
  ];

  if (openRouterKey) {
    entries.push({
      bucket: 'openrouter (OPENROUTER_API_KEY)',
      key: openRouterKey,
      isGoogle: false,
    });
  }

  for (const entry of entries) {
    if (!entry.key) {
      console.log(` ⚠️  ${entry.bucket.padEnd(38)}: SKIPPED (no key)`);
      continue;
    }

    const start = Date.now();
    try {
      if (entry.isGoogle) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${entry.key}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
        });
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        if (res.ok) {
          console.log(` ✓  ${entry.bucket.padEnd(38)}: ACTIVE (HTTP ${res.status}, ${elapsed}s)`);
        } else {
          console.log(` ✗  ${entry.bucket.padEnd(38)}: FAILED (HTTP ${res.status}, ${elapsed}s)`);
        }
      } else {
        const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${entry.key}` },
        });
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        if (res.ok) {
          console.log(` ✓  ${entry.bucket.padEnd(38)}: ACTIVE (HTTP ${res.status}, ${elapsed}s)`);
        } else {
          console.log(` ✗  ${entry.bucket.padEnd(38)}: FAILED (HTTP ${res.status}, ${elapsed}s)`);
        }
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(
        ` ✗  ${entry.bucket.padEnd(38)}: ERROR (${err instanceof Error ? err.message : String(err)}, ${elapsed}s)`,
      );
    }
  }

  console.log(`${'='.repeat(70)}\n`);
}
