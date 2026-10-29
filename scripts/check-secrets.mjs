import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { extname, basename } from 'node:path';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.jsonc',
  '.md',
  '.txt',
  '.py',
  '.html',
  '.css',
  '.svg',
  '.sql',
  '.yml',
  '.yaml',
  '.toml',
]);
const rules = [
  ['age private key', /AGE-SECRET-KEY-1[0-9A-Z]{50,}/],
  ['private PEM', /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['secret MCP URL', /\/mcp\/[A-Za-z0-9_-]{43}(?=[\s"'?)\/]|$)/],
  ['literal bearer credential', /\bBearer [A-Za-z0-9_-]{32,}/],
  [
    'literal secret value',
    /"(?:access_token|refresh_token|client_secret|age_private|sign_private|password)"\s*:\s*"[A-Za-z0-9_\/=+.-]{20,}"/,
  ],
];
const issues = [];
for (const file of files) {
  if (
    file.split('/').some((p) => ['.state', '.wrangler', '.venv', 'node_modules'].includes(p)) ||
    ['endpoint-secret.json', 'connection-tokens.json', '.dev.vars', '.env'].includes(basename(file))
  ) {
    issues.push([file, 'runtime/credential file']);
    continue;
  }
  const info = lstatSync(file);
  if (!info.isFile() || !textExtensions.has(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const [label, pattern] of rules) if (pattern.test(text)) issues.push([file, label]);
}
if (issues.length) {
  for (const [file, rule] of issues) console.error(`Potential secret rejected: ${file} (${rule})`);
  process.exit(1);
}
console.log(
  `Secret-pattern and runtime-file checks passed for ${files.length} repository files. This is an auxiliary check, not a security audit.`,
);
