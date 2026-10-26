import { execFileSync } from 'node:child_process';

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// "diff --git a/<p> b/<q>": for non-renames p === q, which disambiguates paths
// containing spaces. Renames are corrected later from rename from/to lines.
function headerPaths(rest) {
  if (!rest.startsWith('a/')) return { oldFile: rest, file: rest };
  for (let i = rest.indexOf(' b/'); i !== -1; i = rest.indexOf(' b/', i + 1)) {
    const a = rest.slice(2, i);
    const b = rest.slice(i + 3);
    if (a === b) return { oldFile: a, file: b };
  }
  const i = rest.lastIndexOf(' b/');
  return i === -1 ? { oldFile: rest, file: rest } : { oldFile: rest.slice(2, i), file: rest.slice(i + 3) };
}

const stripTab = (s) => s.replace(/\t.*$/, '');

export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let oldLine = 0;
  for (const line of text.split('\n')) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '+') {
        cur.added.push({ line: newLine++, text: line.slice(1) });
        newLeft--;
        continue;
      }
      if (c === '-') {
        cur.removed.push({ line: oldLine++, text: line.slice(1) });
        oldLeft--;
        continue;
      }
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
        newLine++;
        oldLine++;
        continue;
      }
      if (c === '\\') continue;
      oldLeft = newLeft = 0;
    }
    if (line.startsWith('diff --git ')) {
      cur = { ...headerPaths(line.slice(11)), status: 'M', binary: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) {
      cur.status = 'R';
      cur.oldFile = line.slice(12);
    } else if (line.startsWith('rename to ')) cur.file = line.slice(10);
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
    else if (line.startsWith('--- a/')) cur.oldFile = stripTab(line.slice(6));
    else if (line.startsWith('+++ b/')) cur.file = stripTab(line.slice(6));
    else {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLine = Number(m[0].match(/^@@ -(\d+)/)[1]);
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLine = Number(m[2]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
      }
    }
  }
  // A deleted file is identified by its old path.
  for (const f of files) if (f.status === 'D') f.file = f.oldFile;
  return files;
}

export function prDiffText(baseSha, headSha, cwd) {
  return git(['diff', '--text', '--no-textconv', '--no-color', '-M', `${baseSha}...${headSha}`], cwd);
}

export function prDiff(baseSha, headSha, cwd) {
  return parseUnifiedDiff(prDiffText(baseSha, headSha, cwd));
}

// The raw diff text restricted to the files keep(file) accepts (file = new
// path, or old path for a deletion), cut at each "diff --git" header.
export function filterDiffText(text, keep) {
  const chunks = String(text ?? '').split(/(?=^diff --git )/m);
  return chunks
    .filter((c) => {
      if (!c.startsWith('diff --git ')) return false;
      const [f] = parseUnifiedDiff(c);
      return Boolean(f) && keep(f.file);
    })
    .join('');
}
