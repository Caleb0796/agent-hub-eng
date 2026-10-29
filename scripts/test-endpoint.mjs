import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const python =
  process.env.AGENT_HUB_PYTHON ?? (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'endpoint/tests', '-v'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
