// Whether a PR is a pure learning PR: every commit authored by the workflow
// bot and every change confined to learned/*.json or to the managed
// "pr-review:learned" blocks of .pr-review/ markdown files. Only such a PR is
// spared the High self-edit finding; anything else touching the reviewer gets it.
import { git } from './diff.mjs';
import { readAt } from './git-read.mjs';
import { PROJECT_SUBDIR } from './config.mjs';

const BOT = 'github-actions[bot]';
const BLOCK = /<!-- pr-review:learned:begin -->[\s\S]*?<!-- pr-review:learned:end -->/g;
const LEARNED_JSON = new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/learned/[\\w.-]+\\.json$`);
const MD = new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/[\\w./-]+\\.md$`);

export function learningPrOnly(baseSha, headSha, cwd) {
  try {
    const authors = git(['log', '--format=%an', `${baseSha}..${headSha}`], cwd).split('\n').filter(Boolean);
    if (!authors.length || authors.some((a) => a !== BOT)) return false;
    const changed = git(['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`], cwd).split('\n').filter(Boolean);
    if (!changed.length) return false;
    return changed.every((f) => {
      if (LEARNED_JSON.test(f)) return true;
      if (!MD.test(f)) return false;
      const before = readAt(baseSha, f, cwd);
      const after = readAt(headSha, f, cwd);
      return before != null && after != null && before.replace(BLOCK, '') === after.replace(BLOCK, '');
    });
  } catch {
    return false;
  }
}
