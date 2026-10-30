const keep = /^(?:Mozilla|AppleWebKit|Chrome|Safari|KHTML|Gecko)(?:\/|$)/i;
const semver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function stripUserAgent(ua) {
  return String(ua).replace(/\s+Electron\/[^\s]+/gi, '').replace(/\s+([^\s/]+)\/([^\s]+)(?=\s|$)/g, (token, name, version) => {
    if (/^Electron$/i.test(name)) return '';
    if (semver.test(version) && !keep.test(name)) return '';
    return token;
  }).replace(/\s{2,}/g, ' ').trim();
}
