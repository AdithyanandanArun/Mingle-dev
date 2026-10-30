import { normalizeNavigationUrl } from './url-policy.ts';
export function validateSignInUrl(input?:string):string { return normalizeNavigationUrl(input?.trim() || 'https://accounts.google.com/'); }
export function buildSignInArgv(profileDir:string,url:string):string[] { return [`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--password-store=basic','--use-mock-keychain','--new-window',validateSignInUrl(url)]; }
