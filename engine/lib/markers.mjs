export const SUMMARY_MARKER = '<!-- pr-review:summary -->';
// The workflow token's identity: it posts the summary comment and, from
// publish, the inline review comments. The model has no posting tool.
export const BOT_AUTHOR = 'github-actions[bot]';

const LEDGER_RE = /<!-- pr-review:ledger v1 ([^ >]+) -->/;
const FP_RE = /<!-- pr-review:fp=([^ >]+) -->/;

export function encodeLedger(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return `<!-- pr-review:ledger v1 ${b64} -->`;
}

export function decodeLedger(body) {
  try {
    const m = LEDGER_RE.exec(String(body ?? ''));
    if (!m || !/^[A-Za-z0-9+/]+={0,2}$/.test(m[1])) return null;
    const parsed = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// The marker text exactly as posted (base64 charset only), or null.
export function rawLedgerMarker(body) {
  const m = LEDGER_RE.exec(String(body ?? ''));
  return m && /^[A-Za-z0-9+/]+={0,2}$/.test(m[1]) ? m[0] : null;
}

export const fpMarker = (slug) => `<!-- pr-review:fp=${slug} -->`;

export function extractInlineSlugs(bodies) {
  const slugs = [];
  for (const b of bodies ?? []) {
    const m = FP_RE.exec(String(b ?? ''));
    if (m) slugs.push(m[1]);
  }
  return slugs;
}
