// recovery-platform's contract checks as pr-review-kit project checks
// (config.checks.project: ["checks/index.mjs"]). Ported unchanged from
// .claude/pr-review/checks/contracts*.mjs; they stay recovery-platform's
// because they encode its Firebase layout and homegroups/regroup twins.
import { checkExports, checkRegion, checkQueriesVsIndexes, checkStoragePaths, checkCollectionsVsRules, checkTwins, useGit } from './contracts.mjs';

export default [
  {
    name: 'checkExports',
    run: ({ files, repoRoot, git }) => {
      useGit((args) => git(args));
      return checkExports(files, repoRoot);
    },
  },
  { name: 'checkRegion', run: ({ files, repoRoot }) => checkRegion(files, repoRoot) },
  { name: 'checkQueriesVsIndexes', run: ({ files, repoRoot }) => checkQueriesVsIndexes(files, repoRoot) },
  { name: 'checkStoragePaths', run: ({ files, repoRoot }) => checkStoragePaths(files, repoRoot) },
  { name: 'checkCollectionsVsRules', run: ({ files, repoRoot }) => checkCollectionsVsRules(files, repoRoot) },
  { name: 'checkTwins', run: ({ files, repoRoot }) => checkTwins(files, repoRoot) },
];
