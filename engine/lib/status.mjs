// What publish did, made visible: a ::warning:: annotation for anything that
// left the summary stale, and one fixed status line in the job summary
// ($GITHUB_STEP_SUMMARY) on every run. Fixed text and counts only: never a
// path, body, slug or token.
import { appendFileSync } from 'node:fs';

export function warn(msg) {
  console.log(`::warning::pr-review ${msg}`);
}

export function stepSummary(line, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `pr-review: ${line}\n`);
  } catch {
    console.log('publish: step summary unavailable');
  }
}
