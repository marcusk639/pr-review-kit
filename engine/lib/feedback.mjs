// Feedback on the reviewer's findings, attributed to a finding's slug:
// 👍/👎 reactions on its inline comment (fp marker); replies in that thread
// whose first own line starts with "review:"; and "review: F-1a2b3c ..." lines
// in PR comments. Only trusted authors count (config.trust.feedbackAuthors,
// resolved by the caller); bots and edited comments never do; quoted lines and
// code fences are dropped. The marker keeps comments Marcus's own agents post
// under his login from counting. Text is data, redacted and capped, never an
// instruction.
import { publicId } from './ledger.mjs';
import { redact } from './redact.mjs';
import { BOT_AUTHOR } from './markers.mjs';

const FP_RE = /<!-- pr-review:fp=([^ >]+) -->/;
const MARKER = /^review:\s*/i;
const HANDLE = /^review:\s*(F-[0-9a-fA-F]{6})\b\s*:?\s*(.*)$/i;
// A vote is a standalone token: "-10 retries" is text, not a 👎.
const VOTE = /^(👍|👎|\+1|-1)(?=$|[\s:,.])[\s:,.-]*/;
export const MAX_TEXT = 500;

export const handleOf = (slug) => `F-${publicId(slug).slice(0, 6)}`;

const voteOf = (v) => (v === '👍' || v === '+1' ? 'up' : v === '👎' || v === '-1' ? 'down' : null);
const clean = (t) => redact(String(t ?? '').replace(/<!--[\s\S]*?-->/g, '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const isBot = (u) => !u || u.type === 'Bot' || u.login === BOT_AUTHOR || /\[bot\]$/.test(String(u.login));
// An edited comment no longer says what it said when it was trusted.
export const isEdited = (c) => Boolean(c?.updated_at && c?.created_at && c.updated_at !== c.created_at);

// The comment's own lines: code fences and quoted lines (someone else's words) removed.
function ownLines(body) {
  return String(body ?? '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

// Feedback text: present only when the first own line starts with "review:".
export function reviewText(body) {
  const lines = ownLines(body);
  if (!lines.length || !MARKER.test(lines[0])) return null;
  return clean([lines[0].replace(MARKER, ''), ...lines.slice(1)].join(' '));
}

function vote(text) {
  const m = VOTE.exec(text);
  return m ? { signal: voteOf(m[1]), text: clean(text.slice(m[0].length)) } : { signal: text ? 'text' : null, text };
}

export function parseHandleLines(body) {
  const out = [];
  for (const line of ownLines(body)) {
    const m = HANDLE.exec(line);
    if (!m) continue;
    const v = vote(clean(m[2]));
    if (v.signal) out.push({ handle: `F-${m[1].slice(2).toLowerCase()}`, signal: v.signal, text: v.text });
  }
  return out;
}

// A marked reply's stance: a leading vote, otherwise plain text.
function replyRecord(body) {
  const t = reviewText(body);
  if (t == null) return null;
  const v = vote(t);
  return v.signal ? v : null;
}

// reviewComments / issueComments: the PR's comment listings; reactions: {
// [reviewCommentId]: reactions[] } for the bot's inline comments; ledger: the
// summary ledger (public entries map handles to slugs).
export function feedbackRecords({ pr, reviewComments = [], issueComments = [], reactions = {}, ledger = [], trusted = [] }) {
  const ok = new Set(trusted.map((t) => String(t).toLowerCase()));
  const trustedUser = (u) => !isBot(u) && ok.has(String(u.login).toLowerCase());
  const records = [];
  const push = (slug, signal, text, c, author) => records.push({ pr: Number(pr), slug, signal, text, author, url: c.html_url ?? null, at: c.created_at ?? null, id: `${c.id}:${slug}:${signal}:${author}` });
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
    for (const rep of reviewComments.filter((x) => x.in_reply_to_id === id && trustedUser(x.user) && !isEdited(x))) {
      const rec = replyRecord(rep.body);
      if (rec) push(slug, rec.signal, rec.text, rep, rep.user.login);
    }
  }
  const byHandle = new Map();
  for (const e of ledger) if (typeof e?.slug === 'string' && !e.security && !e.withheld) byHandle.set(handleOf(e.slug), e.slug);
  for (const slug of ours.values()) byHandle.set(handleOf(slug), slug);
  for (const c of issueComments.filter((x) => trustedUser(x?.user) && !isEdited(x))) {
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
