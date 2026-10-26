// The private channel for a private repo (config.securityChannel
// "repo-comments"): its PR comments, logs and artifacts are readable only by
// its collaborators, so when every collaborator is a configured reader the
// comments themselves may carry security detail. Checked on every publish and
// fail-closed: a public repo, an unknown collaborator, an empty listing or any
// API failure means "not verified" and security detail is withheld.
const MAX_PAGES = 10;

export async function verifyPrivateChannel(repo, readers, request) {
  if (!request) return { verified: false, reason: 'no API client' };
  const allowed = new Set((readers ?? []).map((r) => String(r).toLowerCase()));
  try {
    const meta = await request('GET', `/repos/${repo}`);
    if (meta?.private !== true) return { verified: false, reason: 'repository is not private' };
    const logins = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await request('GET', `/repos/${repo}/collaborators?affiliation=all&per_page=100&page=${page}`);
      if (!Array.isArray(items)) return { verified: false, reason: 'collaborators unreadable' };
      logins.push(...items.map((c) => String(c?.login ?? '').toLowerCase()));
      if (items.length < 100) break;
      if (page === MAX_PAGES) return { verified: false, reason: 'too many collaborators' };
    }
    if (!logins.length) return { verified: false, reason: 'no collaborators listed' };
    if (logins.some((l) => !allowed.has(l))) return { verified: false, reason: 'a collaborator is not a configured reader' };
    return { verified: true };
  } catch (err) {
    return { verified: false, reason: `API ${Number.isInteger(err?.status) ? err.status : 'error'}` };
  }
}
