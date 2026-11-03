import { writeFileSync } from 'node:fs';
import { runEval } from '../evals/injection';
import { museClient } from '../src/server/runner';

// Tries each chat attack against the live model and records counts, never the model's text.
// Needs the network and spends money, so it is not part of `npm run check`.
const apiKey = process.env.MUSE_API_KEY;
if (!apiKey) {
  console.error('Set MUSE_API_KEY to run this evaluation.');
  process.exit(1);
}
const model = process.env.MUSE_MODEL ?? 'muse-spark-1.3';
const report = await runEval(
  museClient({ apiKey, model, base: process.env.MUSE_API_BASE ?? 'https://api.meta.ai/v1' }),
  Number(process.env.EVAL_REPEATS ?? 3),
);
const date = new Date().toISOString().slice(0, 10);
const path = `docs/evidence/injection-eval-${date}.json`;
writeFileSync(path, `${JSON.stringify({ date, model, ...report }, null, 2)}\n`);
console.log(`${report.resisted} resisted, ${report.broke} broke, wrote ${path}`);
