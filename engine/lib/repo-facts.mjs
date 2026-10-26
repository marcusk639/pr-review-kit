// Repository-level facts: merges from the base branch inside the PR range,
// and (checks.writeCollaborators) writers outside an allowed list.
import { git } from './diff.mjs';
import { activeProject, resolveAuthors } from './config.mjs';

// Merge commits in base..head with a parent already on the base branch.
export function mergeFromBase(baseSha, headSha, cwd) {
  try {
    const lines = git(['log', '--merges', '--format=%H %P%x09%s', `${baseSha}..${headSha}`], cwd).split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(0, 30)) {
      const [ids, subject = ''] = l.split('\t');
      const [sha, ...parents] = ids.split(' ');
      const fromBase = parents.slice(1).some((p) => {
        try {
          git(['merge-base', '--is-ancestor', p, baseSha], cwd);
          return true;
        } catch {
          return false;
        }
      });
      if (fromBase) out.push({ check: 'merge-from-base', file: 'commits', note: `merge from base: ${sha.slice(0, 7)} ${subject.slice(0, 120)}` });
    }
    return out;
  } catch {
    return [{ check: 'merge-from-base', file: 'commits', note: 'merge-from-base unavailable' }];
  }
}

// status: number of unexpected writers, or "unreadable". Logins never appear.
export async function writeCollaborators(repo, request) {
  const cfg = activeProject().config.checks.writeCollaborators;
  if (!cfg) return { facts: [], status: null };
  const allowed = new Set(resolveAuthors(cfg.allowed, repo));
  try {
    const list = [];
    for (let page = 1; page <= 10; page++) {
      const items = await request('GET', `/repos/${repo}/collaborators?affiliation=all&per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('not a list');
      list.push(...items);
      if (items.length < 100) break;
    }
    const writers = list.filter((c) => c?.permissions && (c.permissions.push || c.permissions.maintain || c.permissions.admin));
    const others = writers.filter((c) => !allowed.has(String(c.login).toLowerCase())).length;
    const facts = others ? [{ check: 'write-collaborators', file: 'repository', note: `${others} collaborator(s) other than the allowed ones can write to this repository; findings and the ledger are visible to them` }] : [];
    return { facts, status: others };
  } catch {
    return { facts: [{ check: 'write-collaborators', file: 'repository', note: 'write collaborators could not be listed; the reviewer cannot tell who else can write here' }], status: 'unreadable' };
  }
}
