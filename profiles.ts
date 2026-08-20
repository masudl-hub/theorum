import { TheorumError } from './error.ts';
import type { Profile } from './types.ts';

const profiles = new Map<string, Profile>();

function registerProfile(profile: Profile): void {
  const { attachments, voice, maxFiles, maxBytes, maxTurnBytes } = profile.inputs;
  if (attachments || voice) {
    if (!(maxFiles && maxBytes && maxTurnBytes)) {
      throw new TheorumError(
        `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`,
      );
    }
  }
  profiles.set(profile.id, profile);
}

function getProfile(id: string): Profile {
  const profile = profiles.get(id);
  if (!profile) {
    throw new TheorumError(`Unknown profile '${id}'`);
  }
  return profile;
}

export { getProfile, registerProfile };
