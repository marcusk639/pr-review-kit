#!/usr/bin/env node
// Posts the review model's one reply per run: `node <kit>/engine/reply.mjs`, no
// arguments (the Review step allows exactly this command when config.model.reply is
// on). The project comes from the trust checkout (.review-base, which the model
// cannot write). See lib/reply.mjs.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghRequest } from './lib/gh.mjs';
import { PROJECT_SUBDIR, setActiveProject } from './lib/config.mjs';
import { loadReviewProject } from './lib/project.mjs';
import { runReply } from './lib/reply.mjs';

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    process.stdout.write('reply refused: no GitHub token in the environment\n');
    return;
  }
  const workspace = process.env.GITHUB_WORKSPACE;
  const project = workspace ? loadReviewProject(join(workspace, '.review-base', PROJECT_SUBDIR)) : null;
  if (project) setActiveProject(project);
  const result = await runReply({
    argv: process.argv.slice(2),
    env: process.env,
    project,
    request: (method, path, body) => ghRequest(method, path, body, token),
  });
  process.stdout.write(`reply ${result.posted ? 'posted' : 'refused'}: ${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.stdout.write('reply failed: Error\n')).finally(() => { process.exitCode = 0; });
}
