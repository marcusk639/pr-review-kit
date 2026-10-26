// Lessons Marcus rejected by closing a learning PR without merging it: their
// feedback sources are treated as consumed, so the next run does not propose
// the same lessons again. Read-only: PR listing and file contents at the
// closed PR's head.
import { PROJECT_SUBDIR } from '../lib/config.mjs';

export async function closedLearningSources({ repo, branch, request, currentLessons = [] }) {
  const owner = repo.split('/')[0];
  const kept = new Set(currentLessons.flatMap((l) => (l.sources ?? []).map((s) => s.id)));
  const out = new Set();
  const prs = await request('GET', `/repos/${repo}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=20`);
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (pr?.merged_at || !/^[0-9a-f]{40}$/.test(pr?.head?.sha ?? '')) continue;
    try {
      const file = await request('GET', `/repos/${repo}/contents/${PROJECT_SUBDIR}/learned/lessons.json?ref=${pr.head.sha}`);
      const json = JSON.parse(Buffer.from(String(file?.content ?? ''), 'base64').toString('utf8'));
      for (const l of Array.isArray(json?.lessons) ? json.lessons : []) for (const s of l.sources ?? []) if (typeof s?.id === 'string' && !kept.has(s.id)) out.add(s.id);
    } catch {
      // unreadable: nothing learned from it
    }
  }
  return [...out];
}
