import { SUMMARY_MARKER } from './markers.mjs';

const API = 'https://api.github.com';
const BOT_LOGIN = 'github-actions[bot]';

// Errors carry only method, status and path; never the token or any body text.
export async function ghRequest(method, path, body, token = process.env.GH_TOKEN) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // Cursor-paginated endpoints (security advisories) expose the rel="next" link
  // as a non-enumerable `next` path on array results; same host only.
  const next = nextPath(res.headers?.get?.('link'));
  if (Array.isArray(data) && next) Object.defineProperty(data, 'next', { value: next });
  return data;
}

export function nextPath(link) {
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(String(link ?? ''));
  return m && m[1].startsWith(`${API}/`) ? m[1].slice(API.length) : null;
}

async function paginate(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await ghRequest('GET', `${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(items)) break;
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

export function listIssueComments(repo, pr) {
  return paginate(`/repos/${repo}/issues/${pr}/comments`);
}

export function listReviewComments(repo, pr) {
  return paginate(`/repos/${repo}/pulls/${pr}/comments`);
}

export async function upsertSummary(repo, pr, body) {
  const comments = await listIssueComments(repo, pr);
  const existing = comments.find(
    (c) => c.user?.login === BOT_LOGIN && typeof c.body === 'string' && c.body.startsWith(SUMMARY_MARKER),
  );
  if (existing) {
    await ghRequest('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    await ghRequest('POST', `/repos/${repo}/issues/${pr}/comments`, { body });
  }
}
