// Renders learned memory: managed blocks inside the knowledge files (active
// lessons only; held and pruned lessons never reach the reviewer) and the body
// of the one learning PR Marcus merges, edits or closes.
export const BEGIN = '<!-- pr-review:learned:begin -->';
export const END = '<!-- pr-review:learned:end -->';
const BLOCK_RE = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);

const day = (at) => String(at ?? '').slice(0, 10) || 'undated';
// Paths come from finding slugs: no markdown or HTML may ride along.
const safe = (p) => String(p ?? '').replace(/[`<>]/g, '');
const scopeLine = (s) => `Scope: ${(s.paths ?? []).map((p) => `\`${safe(p)}\``).join(', ')}; class ${s.class}${s.linkTypes?.length ? `; link types: ${s.linkTypes.join(', ')}` : ''}`;
const sourcesLine = (srcs) => `Sources: ${(srcs ?? []).map((x) => `${x.url} (#${x.pr}, ${day(x.at)})`).join('; ')}`;

// One line, no HTML comments: a rule can never close the managed block.
const oneLine = (t) => String(t ?? '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();

export function lessonItem(l, { withRule = true } = {}) {
  const rule = withRule ? oneLine(l.rule) : '(text withheld: security; see the sources)';
  return [`- **${l.id}** (${l.date}) ${rule}`, `  - ${scopeLine(l.scope)}`, `  - ${sourcesLine(l.sources)}`].join('\n');
}

// texts: { [knowledge file]: current text }. Returns the same keys, re-rendered.
export function renderKnowledge(texts, lessons) {
  const out = {};
  for (const [file, text] of Object.entries(texts)) {
    const mine = lessons.filter((l) => l.status === 'active' && l.target === file).sort((a, b) => a.id.localeCompare(b.id));
    const block = `${BEGIN}\n${mine.map((l) => `${lessonItem(l)}\n`).join('')}${END}`;
    if (BLOCK_RE.test(text)) out[file] = text.replace(BLOCK_RE, () => block);
    else if (mine.length) out[file] = `${text.replace(/\n*$/, '\n')}\n## Learned from review feedback\n\n${block}\n`;
    else out[file] = text;
  }
  return out;
}

function section(title, items, render, empty = null) {
  if (!items.length) return empty ? [`## ${title}`, '', empty, ''] : [];
  return [`## ${title}`, '', ...items.map(render), ''];
}

const isSecurityHold = (l) => /security/.test(String(l.why ?? ''));

export function renderPrBody({ added = [], replaced = [], pruned = [], flagged = [], unresolved = [], precisionMd = '', config, notes = [] }) {
  const pub = config.visibility === 'public';
  return [
    'Advisory memory for the PR reviewer, distilled from maintainers\' 👍/👎 and replies on its comments. Nothing here reaches the reviewer until this PR is merged; edit or drop any lesson first. `learned/lessons.json` is the source of truth; the knowledge files carry rendered copies.',
    '',
    ...notes.map((n) => `> ${n}`),
    ...(notes.length ? [''] : []),
    ...section('Added', added, (l) => lessonItem(l)),
    ...section('Replaced', replaced, (l) => lessonItem(l)),
    ...section('Pruned (paths no longer exist)', pruned, (l) => lessonItem(l)),
    ...section(
      'Needs your decision',
      flagged,
      (l) => `${lessonItem(l, { withRule: !isSecurityHold(l) })}\n  - Held because ${l.why}. To accept it, set its "status" to "active" in learned/lessons.json in this PR; to reject it, delete it.`,
    ),
    ...section('Unresolved feedback', unresolved, (u) => `- ${u.url ?? '(no link)'}${u.pr ? ` (#${u.pr})` : ''}: ${u.reason}${u.text && !pub ? ` — "${u.text}"` : ''}`),
    '## Precision',
    '',
    precisionMd || '(no votes yet)',
    '',
  ].join('\n');
}
