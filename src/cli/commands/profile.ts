import { getProfile, listProfiles } from '../../kernel/registry/profiles.ts';

export function listProfilesCommand(): void {
  const profiles = listProfiles();
  console.log('\n Registered Theorum Profiles:');
  console.log('='.repeat(70));
  if (profiles.length === 0) {
    console.log('  (No profiles registered in runtime)');
    console.log(`${'='.repeat(70)}\n`);
    return;
  }

  for (const p of profiles) {
    const inputs: string[] = [];
    if (p.inputs.text !== false) inputs.push('text');
    if (p.inputs.voice) inputs.push('voice');
    if (p.inputs.attachments)
      inputs.push(`attachments [${p.inputs.attachments.accept?.join(', ')}]`);

    const tools = p.tools.allow?.length ? p.tools.allow.join(', ') : 'none';
    const models = p.model.allow?.join(', ') || 'default';
    const structured =
      typeof p.outputs.structured === 'string'
        ? p.outputs.structured
        : p.outputs.structured
          ? 'custom'
          : 'none';

    console.log(` • Profile: ${p.id.padEnd(16)} (handle: ${p.identity.handle})`);
    console.log(`   - Models:     ${models}`);
    console.log(`   - Inputs:     ${inputs.join(' | ')}`);
    console.log(`   - Tools:      ${tools}`);
    console.log(`   - Structured: ${structured}`);
    console.log(`   - Key Bucket: ${p.model.key ?? 'portfolio'}`);
    console.log('-'.repeat(70));
  }
  console.log(`Total: ${profiles.length} profiles registered.\n`);
}

export function showProfileCommand(profileId: string): void {
  try {
    const profile = getProfile(profileId);
    console.log(`\n Profile Details: ${profileId}`);
    console.log('='.repeat(70));
    console.log(JSON.stringify(profile, null, 2));
    console.log(`${'='.repeat(70)}\n`);
  } catch (err) {
    console.error(`\n Error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
