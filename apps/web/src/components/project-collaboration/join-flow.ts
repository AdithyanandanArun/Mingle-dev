import type { DirectoryListing } from '@mingle/contracts';

type DirectoryLookup = (path: string, query: string, hidden: boolean) => Promise<DirectoryListing>;

/** Resolve the typed parent path at submit time so a stale Browse result cannot override it. */
export async function resolveJoinCloneParent(path: string, lookup: DirectoryLookup): Promise<DirectoryListing> {
  const requestedPath = path.trim();
  if (!requestedPath) throw new Error('Choose a parent folder for the repository checkout.');
  const listing = await lookup(requestedPath, '', false);
  if (!(listing.canCreateWithin ?? listing.canSelect)) {
    throw new Error('Choose an existing folder where Mingle can create the repository checkout.');
  }
  return listing;
}

export function joinSuccessCopy(agentCount: number, consentSkipped: boolean): string {
  if (consentSkipped) return 'Your agents remain private until you choose to share them later. No model run has started.';
  const count = Math.max(0, Math.floor(agentCount));
  const noun = count === 1 ? 'agent' : 'agents';
  const verb = count === 1 ? 'is' : 'are';
  return `${count} idle ${noun} ${verb} ready. The project lead can now add your ${noun} from Add agents. No model run has started.`;
}
