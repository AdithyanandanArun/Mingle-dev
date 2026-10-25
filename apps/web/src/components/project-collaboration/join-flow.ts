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
