import type { Provider } from '@mingle/contracts';
import { PROVIDER_NAMES } from './providers';

const LEGACY_AGENT_NAME = /^Teammate agent [0-9a-f]{12}( \d+)?$/i;

function providerLabel(provider: string): string {
  return provider in PROVIDER_NAMES ? PROVIDER_NAMES[provider as Provider] : provider;
}

/** Replaces the old opaque join-session label with a useful person/provider identity. */
export function teamAgentDisplayName(name: string, ownerDisplayName: string, provider: string): string {
  const cleanName = name.trim();
  if (!LEGACY_AGENT_NAME.test(cleanName)) return cleanName || `${ownerDisplayName}'s ${providerLabel(provider)}`;
  const firstName = ownerDisplayName.trim().split(/\s+/)[0] || 'Teammate';
  return `${firstName}'s ${providerLabel(provider)}`;
}

/** Consistent owner, provider, model and device metadata for teammate-agent listings. */
export function teamAgentMetadata(input: {
  ownerDisplayName: string;
  provider: string;
  model: string;
  deviceName: string;
}): string {
  return `${input.ownerDisplayName} · ${providerLabel(input.provider)} · ${input.model} · ${input.deviceName}`;
}
