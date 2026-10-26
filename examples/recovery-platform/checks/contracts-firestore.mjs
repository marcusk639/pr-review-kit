import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-product Firebase config locations (repo-relative).
const CONFIG = {
  homegroups: {
    indexes: 'homegroups/firestore.indexes.json',
    firestoreRules: 'homegroups/firestore.rules',
    storageRules: 'homegroups/storage.rules',
  },
  regroup: {
    indexes: 'regroup/mobile/firebase/firestore.indexes.json',
    firestoreRules: 'regroup/mobile/firebase/firestore.rules',
    storageRules: 'regroup/mobile/firebase/storage.rules',
  },
};

const CODE = /\.(?:ts|tsx|js|jsx|mjs)$/;
const TEST = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[jt]sx?$/;
const COLLECTION = /\bcollection\(\s*(?:[\w.]+\s*,\s*)?['"]([\w][\w-]*)['"]/;

export const productOf = (path) => {
  const seg = path.split('/')[0];
  return CONFIG[seg] ? seg : null;
};

const eligible = (f) => !f.binary && f.status !== 'D' && CODE.test(f.file) && !TEST.test(f.file);

const readText = (root, rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `match /X/` at the top level or under a wildcard prefix such as /{path=**}/X/.
const hasMatch = (rules, seg) => new RegExp(`match\\s+/(?:\\{[^}]*\\}/)?${esc(seg)}(?:/|\\s|\\{)`).test(rules);

// Lines of the file at head when readable (gives collection() context), else
// just the added lines.
function contextLines(root, f) {
  const text = readText(root, f.file);
  if (text === null) return f.added.map((a) => ({ line: a.line, text: a.text }));
  return text.split('\n').map((t, i) => ({ line: i + 1, text: t }));
}

// One fact per index file that cannot be read or parsed, so the model knows
// the check did not run rather than reading silence as "no missing index".
function indexGroups(root, product, facts, reported) {
  const path = CONFIG[product].indexes;
  const unavailable = (why) => {
    if (!reported.has(path)) facts.push({ check: 'queries-vs-indexes', file: path, line: null, note: `queries-vs-indexes unavailable: index file ${why}` });
    reported.add(path);
    return null;
  };
  const text = readText(root, path);
  if (text === null) return unavailable('missing');
  try {
    const list = JSON.parse(text).indexes ?? [];
    if (!Array.isArray(list)) return unavailable('unparsable');
    return new Set(list.map((i) => i?.collectionGroup));
  } catch {
    return unavailable('unparsable');
  }
}

export function checkQueriesVsIndexes(files, root) {
  const facts = [];
  const reported = new Set();
  for (const f of files) {
    const product = productOf(f.file);
    if (!product || !eligible(f)) continue;
    const groups = indexGroups(root, product, facts, reported);
    if (!groups) continue;
    const ctx = contextLines(root, f);
    const byLine = new Map(ctx.map((c, i) => [c.line, i]));
    const addedLines = new Set(f.added.map((a) => a.line));
    const orders = ctx.filter((c) => addedLines.has(c.line) && c.text.includes('.orderBy(')).map((c) => c.line);
    for (const a of f.added) {
      if (!a.text.includes('.where(')) continue;
      if (!orders.some((o) => Math.abs(o - a.line) <= 5)) continue;
      let coll = null;
      for (let i = byLine.get(a.line) ?? -1; i >= 0 && i >= (byLine.get(a.line) ?? 0) - 30; i--) {
        const m = COLLECTION.exec(ctx[i].text);
        if (m) {
          coll = m[1];
          break;
        }
      }
      if (!coll) continue;
      const has = groups.has(coll);
      facts.push({
        check: 'queries-vs-indexes',
        file: f.file,
        line: a.line,
        note: has
          ? `where+orderBy on '${coll}'; composite index for it exists in ${CONFIG[product].indexes} (check field order)`
          : `where+orderBy on '${coll}'; no composite index for it in ${CONFIG[product].indexes}`,
      });
    }
  }
  return facts;
}

export function checkStoragePaths(files, root) {
  const facts = [];
  for (const f of files) {
    const product = productOf(f.file);
    if (!product || !eligible(f)) continue;
    const rules = readText(root, CONFIG[product].storageRules);
    if (rules === null) continue;
    for (const a of f.added) {
      const m = /\bref\(\s*['"`]([^'"`$]+)/.exec(a.text);
      if (!m) continue;
      const seg = m[1].replace(/^\/+/, '').split('/')[0];
      if (!seg || hasMatch(rules, seg)) continue;
      facts.push({
        check: 'storage-paths',
        file: f.file,
        line: a.line,
        note: `storage path '${seg}/' has no 'match /${seg}/' in ${CONFIG[product].storageRules}`,
      });
    }
  }
  return facts;
}

export function checkCollectionsVsRules(files, root) {
  const facts = [];
  for (const f of files) {
    const product = productOf(f.file);
    if (!product || !eligible(f)) continue;
    const rules = readText(root, CONFIG[product].firestoreRules);
    if (rules === null) continue;
    for (const a of f.added) {
      const m = COLLECTION.exec(a.text);
      if (!m || hasMatch(rules, m[1])) continue;
      facts.push({
        check: 'collections-vs-rules',
        file: f.file,
        line: a.line,
        note: `collection '${m[1]}' has no 'match /${m[1]}/' in ${CONFIG[product].firestoreRules}`,
      });
    }
  }
  return facts;
}
