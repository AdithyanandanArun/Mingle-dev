import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../common.ts';
import { claudeEnvironment } from '../claude/auth.ts';
import { opencodeEnvironment } from '../opencode/runtime.ts';

describe('desktop browser relay environment boundary', () => {
  it.each([cleanEnv, claudeEnvironment, opencodeEnvironment])('withholds the unrestricted relay from provider children', (environment) => {
    const child = environment({
      PATH: '/test/bin', ANTHROPIC_API_KEY: 'example-provider-key',
      MINGLE_EMBEDDED_BROWSER_TOKEN: 'example-desktop-secret',
      MINGLE_EMBEDDED_BROWSER_URL: 'http://127.0.0.1:1234',
    });
    expect(child.MINGLE_EMBEDDED_BROWSER_TOKEN).toBeUndefined();
    expect(child.MINGLE_EMBEDDED_BROWSER_URL).toBeUndefined();
    expect(child.PATH).toBe('/test/bin');
  });
});
