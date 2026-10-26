// Publish with posting replaced by printing: the same render path as a real
// run, for consumers checking their setup locally (bin/pr-review.mjs local).
// Nothing reaches GitHub. Security findings' private detail is printed only
// with showPrivate, and never when GITHUB_ACTIONS is set (a CI log could be
// public).
import { activeProject } from './config.mjs';

export function dryRunDeps({ write = (s) => process.stdout.write(s), headSha, env = process.env, showPrivate = false, assumePrivateVerified = false, issueComments = [] }) {
  const show = Boolean(showPrivate) && env.GITHUB_ACTIONS !== 'true';
  const section = (title, body = '') => write(`\n=== ${title} ===\n${body}${body.endsWith('\n') || !body ? '' : '\n'}`);
  const request = async (method, path, body) => {
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path)) return { head: { sha: headSha } };
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return { private: Boolean(assumePrivateVerified) };
    if (method === 'GET' && path.includes('/collaborators')) return assumePrivateVerified ? activeProject().config.privateReaders.map((login) => ({ login })) : [];
    if (method === 'POST' && path.endsWith('/reviews')) {
      const cs = body?.comments ?? [];
      section(`inline review (${cs.length} comment${cs.length === 1 ? '' : 's'})`, cs.map((c) => `--- ${c.path}:${c.line} (${c.side})\n${c.body}`).join('\n'));
      return {};
    }
    section(`would call ${method} ${path}`);
    return null;
  };
  return {
    showPrivate: show,
    listIssueComments: async () => issueComments,
    listReviewComments: async () => [],
    upsertSummary: async (repo, pr, text) => section('summary comment', text),
    request,
    deliverAdvisories: async (repo, pr, findings) => {
      const n = findings.length;
      if (!show) section(`advisories: ${n} security finding(s) would go to draft advisories (details hidden; --show-private to print)`);
      else section(`advisories: ${n} security finding(s)`, JSON.stringify(findings, null, 2));
      return { delivered: true, resolvedIds: [] };
    },
    report: (line) => section('status', line),
  };
}
