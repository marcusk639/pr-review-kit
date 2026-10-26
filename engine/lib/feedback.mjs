// Feedback on the reviewer's findings, attributed to a finding's slug:
// 👍/👎 reactions and replies on its inline comment (fp marker), and handle
// lines ("F-1a2b3c 👎 reason") in PR comments for findings without one. Only
// trusted authors (config.trust.feedbackAuthors) count; bots never do. Text is
// data: it is redacted and capped here and never interpreted as an instruction.
import { publicId } from './ledger.mjs';
import { redact } from './redact.mjs';
import { BOT_AUTHOR } from './markers.mjs';

const FP_RE = /<!-- pr-review:fp=([^ >]+) -->/;
const HANDLE_LINE = /^\s*(F-[0-9a-fA-F]{6})\b[ \t]*(👍|👎|\+1|-1)?[ \t:,-]*(.*)$/;
const LEAD_VOTE = /^\s*(👍|👎|\+1|-1)[\s:,-]*/;
export const MAX_TEXT = 500;

export const handleOf = (slug) => `F-${publicId(slug).slice(0, 6)}`;

const voteOf = (v) => (v === '👍' || v === '+1' ? 'up' : v === '👎' || v === '-1' ? 'down' : null);
const clean = (t) => redact(String(t ?? '').replace(/<!--[\s\S]*?-->/g, '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const isBot = (u) => !u || u.type === 'Bot' || u.login === BOT_AUTHOR || /\[bot\]$/.test(String(u.login));

export function parseHandleLines(body) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = HANDLE_LINE.exec(line);
    if (!m) continue;
    const text = clean(m[3]);
    const signal = voteOf(m[2]) ?? (text ? 'text' : null);
    if (signal) out.push({ handle: `F-${m[1].slice(2).toLowerCase()}`, signal, text });
  }
  return out;
}

// A reply's stance: a leading vote, otherwise plain text.
function replyRecord(body) {
  const raw = String(body ?? '');
  const m = LEAD_VOTE.exec(raw);
  const text = clean(m ? raw.slice(m[0].length) : raw);
  const signal = m ? voteOf(m[1]) : 'text';
  return text || signal !== 'text' ? { signal, text } : null;
}

// reviewComments / issueComments: the PR's comment listings; reactions: {
// [reviewCommentId]: reactions[] } for the bot's inline comments; ledger: the
// summary ledger (public entries map handles to slugs).
export function feedbackRecords({ pr, reviewComments = [], issueComments = [], reactions = {}, ledger = [], trusted = [] }) {
  const ok = new Set(trusted.map((t) => String(t).toLowerCase()));
  const trustedUser = (u) => !isBot(u) && ok.has(String(u.login).toLowerCase());
  const records = [];
  const push = (slug, signal, text, c, author) => records.push({ pr: Number(pr), slug, signal, text, author, url: c.html_url ?? null, at: c.created_at ?? null, id: `${c.id}:${signal}:${author}` });
  const ours = new Map();
  for (const c of reviewComments) {
    const m = c?.user?.login === BOT_AUTHOR && c.in_reply_to_id == null ? FP_RE.exec(String(c.body ?? '')) : null;
    if (m) ours.set(c.id, m[1]);
  }
  for (const [id, slug] of ours) {
    const c = reviewComments.find((x) => x.id === id);
    for (const r of reactions[id] ?? []) {
      const signal = voteOf(r.content === '+1' ? '+1' : r.content === '-1' ? '-1' : null);
      if (signal && trustedUser(r.user)) push(slug, signal, '', { ...c, created_at: r.created_at, id: `${id}r` }, r.user.login);
    }
    for (const rep of reviewComments.filter((x) => x.in_reply_to_id === id && trustedUser(x.user))) {
      const rec = replyRecord(rep.body);
      if (rec) push(slug, rec.signal, rec.text, rep, rep.user.login);
    }
  }
  const byHandle = new Map();
  for (const e of ledger) if (typeof e?.slug === 'string' && !e.security && !e.withheld) byHandle.set(handleOf(e.slug), e.slug);
  for (const slug of ours.values()) byHandle.set(handleOf(slug), slug);
  for (const c of issueComments.filter((x) => trustedUser(x?.user))) {
    for (const h of parseHandleLines(c.body)) {
      const slug = byHandle.get(h.handle);
      if (slug) push(slug, h.signal, h.text, c, c.user.login);
    }
  }
  return records;
}

const MAX_CORRECTIONS = 10;

// What the next run on the same PR gets: slugs with a trusted 👎 (not
// re-raised) and the text corrections (quoted to the model as data).
export function prFeedback(records) {
  const rejected = [];
  const corrections = [];
  for (const r of records ?? []) {
    if (r.signal === 'down' && !rejected.includes(r.slug)) rejected.push(r.slug);
    if (r.text && corrections.length < MAX_CORRECTIONS) corrections.push({ slug: r.slug, signal: r.signal, text: r.text });
  }
  return { rejectedSlugs: rejected, corrections };
}
