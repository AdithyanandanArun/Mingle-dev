export function activityEventInScope(eventProjectId: string | null, activeProjectId: string | undefined, allProjects: boolean): boolean {
  return allProjects || (activeProjectId !== undefined && eventProjectId === activeProjectId);
}

export function activityMatchesSearch(search: string, ...values: Array<string | null | undefined>): boolean {
  const query = search.trim().toLocaleLowerCase();
  return !query || values.some((value) => value?.toLocaleLowerCase().includes(query));
}
