import { it, expect } from 'vitest';
import { consentCsp, defaultCsp } from '../src/server/security';

it('adds only the verified callback path to consent CSP without query data or directive injection', () => {
  const callback = 'https://agent.meta.ai/api/hatch/oauth/callback';
  expect(consentCsp(callback + '?state=private')).toBe(
    defaultCsp.replace("form-action 'self'", `form-action 'self' ${callback}`),
  );
  const injected = consentCsp('https://muse.ai/callback;script-src%20*');
  expect(injected.split(';').length).toBe(defaultCsp.split(';').length);
  expect(injected).toContain("script-src 'self'");
  expect(injected).toContain('/callback%3Bscript-src%20*');
});
