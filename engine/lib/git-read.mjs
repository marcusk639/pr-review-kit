// Reads PR or base content from git objects at a given commit, never from the
// working tree, so a symlink in the PR cannot redirect a read to runner files
// (a committed symlink is a blob holding its target; readAt refuses it).
// Used by facts and handed to project checks as readHead/readBase/listFiles.
import { git } from './diff.mjs';
import { matches } from './glob.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const PATH_OK = (p) => typeof p === 'string' && p !== '' && !p.startsWith('-') && !p.startsWith('/') && !p.split('/').includes('..');

// Mode and type of one path at sha, or null.
function entry(sha, path, cwd) {
  try {
    const line = git(['ls-tree', '-z', '--full-tree', sha, '--', path], cwd).split('\0')[0];
    const m = /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/.exec(line);
    return m && m[3] === path ? { mode: m[1], type: m[2] } : null;
  } catch {
    return null;
  }
}

export function readAt(sha, path, cwd) {
  if (!SHA_RE.test(String(sha)) || !PATH_OK(path)) return null;
  const e = entry(sha, path, cwd);
  if (!e || e.type !== 'blob' || e.mode === '120000') return null;
  try {
    return git(['cat-file', 'blob', `${sha}:${path}`], cwd);
  } catch {
    return null;
  }
}

export function listAt(sha, glob, cwd) {
  if (!SHA_RE.test(String(sha))) return [];
  try {
    return git(['ls-tree', '-r', '-z', '--full-tree', sha], cwd)
      .split('\0')
      .map((l) => /^(\d{6}) blob [0-9a-f]+\t(.*)$/.exec(l))
      .filter((m) => m && m[1] !== '120000' && matches(m[2], glob))
      .map((m) => m[2]);
  } catch {
    return [];
  }
}
