export const defaultCsp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Called only after the OAuth redirect passed the server's callback allowlist. */
export function consentCsp(redirectUri: string): string {
  const callback = new URL(redirectUri);
  // CSP source paths exclude query/fragment, and cannot inject new directives.
  const path = callback.pathname.replace(
    /[\s;'"<>]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return defaultCsp.replace("form-action 'self'", `form-action 'self' ${callback.origin}${path}`);
}
