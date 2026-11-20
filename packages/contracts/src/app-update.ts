export interface AppUpdateInfo {
  installedVersion: string;
  latestVersion: string | null;
  status: 'available' | 'current' | 'unavailable';
  checkedAt: string;
}
