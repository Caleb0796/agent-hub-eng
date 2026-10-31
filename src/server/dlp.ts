// Pre-delivery scan for credential-shaped text in Agent drafts. Only fixed-format secrets
// can be caught; general personal data is out of reach. Rules extend
// scripts/check-secrets.mjs.
const rules: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['age private key', /AGE-SECRET-KEY-1[0-9A-Z]{50,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['AWS secret key', /aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['bearer credential', /\bbearer [A-Za-z0-9._~+/-]{32,}=*/i],
  // No \b before the name, so DB_PASSWORD= and OAUTH_CLIENT_SECRET= match; an optional
  // closing quote covers JSON and quoted keys.
  [
    'password assignment',
    /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  ],
  // Needs a value after the word, so talking about passwords in Chinese stays untouched.
  [
    '中文密码或验证码',
    /(?:密码|口令|密钥|验证码)\s*(?:是|为|:|：|=)?\s*[A-Za-z0-9!@#$%^&*_+=.-]{4,}/,
  ],
  [
    'literal secret value',
    /"(?:access_token|refresh_token|client_secret|password)"\s*:\s*"[A-Za-z0-9_\/=+.-]{20,}"/i,
  ],
];

export function scan(text: string): string[] {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
