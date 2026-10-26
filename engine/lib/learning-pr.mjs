// Whether a PR is a pure learning PR. Two independent conditions, both needed
// to spare it the High self-edit finding:
// - verifyLearningPr (GitHub API, never git metadata, which a pusher controls):
//   opened by github-actions[bot], from this repo's learning branch, every
//   commit's GitHub author and committer the bot;
// - learningPrOnly (git objects): every change confined to learned/*.json or
//   the managed blocks of .pr-review/*.md, and that content matching the
//   schema the learning job writes.
import { git } from './diff.mjs';
import { readAt } from './git-read.mjs';
import { PROJECT_SUBDIR } from './config.mjs';

const BOT = 'github-actions[bot]';
const BLOCK = /<!-- pr-review:learned:begin -->[\s\S]*?<!-- pr-review:learned:end -->/g;
const LEARNED_JSON = new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/learned/[\\w.-]+\\.json$`);
const MD = new RegExp(`^${PROJECT_SUBDIR.replace('.', '\\.')}/[\\w./-]+\\.md$`);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const LESSON_LINE = /^(- \*\*L-[\w-]+\*\* \([^)]*\) .*|  - Scope: .*|  - Sources: .*)$/;

// The content a learning commit may carry: the JSON shapes and the rendered
// lesson lines apply/render produce, nothing else.
export function learnedContentValid(path, text) {
  try {
    if (/\/learned\/lessons\.json$/.test(path)) {
      const j = JSON.parse(text);
      return j.version === 1 && Array.isArray(j.lessons) && j.lessons.every((l) => isObj(l) && typeof l.id === 'string' && ['active', 'needs-decision'].includes(l.status) && typeof l.rule === 'string' && typeof l.target === 'string' && isObj(l.scope) && Array.isArray(l.sources)) && (j.consumed === undefined || (Array.isArray(j.consumed) && j.consumed.every((x) => typeof x === 'string')));
    }
    if (/\/learned\/precision\.json$/.test(path)) {
      const j = JSON.parse(text);
      return j.version === 1 && isObj(j.byPr);
    }
    if (/\.md$/.test(path)) {
      return [...String(text).matchAll(BLOCK)].every((m) => m[0].split('\n').slice(1, -1).every((l) => l === '' || LESSON_LINE.test(l)));
    }
    return false;
  } catch {
    return false;
  }
}

export async function verifyLearningPr({ repo, pr, branch, request }) {
  try {
    const p = await request('GET', `/repos/${repo}/pulls/${pr}`);
    if (p?.user?.login !== BOT || p?.head?.repo?.full_name !== repo || p?.head?.ref !== branch) return false;
    const commits = await request('GET', `/repos/${repo}/pulls/${pr}/commits?per_page=100`);
    return Array.isArray(commits) && commits.length > 0 && commits.length < 100 && commits.every((c) => c?.author?.login === BOT && c?.committer?.login === BOT);
  } catch {
    return false;
  }
}

export function learningPrOnly(baseSha, headSha, cwd) {
  try {
    const changed = git(['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`], cwd).split('\n').filter(Boolean);
    if (!changed.length) return false;
    return changed.every((f) => {
      const after = readAt(headSha, f, cwd);
      if (after == null || !learnedContentValid(f, after)) return false;
      if (LEARNED_JSON.test(f)) return true;
      if (!MD.test(f)) return false;
      const before = readAt(baseSha, f, cwd);
      return before != null && before.replace(BLOCK, '') === after.replace(BLOCK, '');
    });
  } catch {
    return false;
  }
}
