// config.withheld: paths the model must never read (private notes, client
// material). The model gets Read denies for them and a diff whose hunks for
// them are replaced by a one-line stub; facts' checks and the secret scan
// still see the full diff; publish never posts an inline comment on them.
import { SAFE_GLOB, activeProject } from './config.mjs';
import { matches } from './glob.mjs';
import { parseUnifiedDiff } from './diff.mjs';
import { createHash } from 'node:crypto';


export const isWithheld = (path, project = activeProject()) => project.config.withheld.some((g) => matches(String(path ?? ''), g));

// A withheld path's NAME can itself be sensitive (client or person names), so
// anything the model reads shows it only as a stable hash.
export const hidePath = (path, project = activeProject()) => (isWithheld(path, project) ? `withheld:${createHash('sha256').update(String(path)).digest('hex').slice(0, 8)}` : path);
export const hidePathsIn = (text, project = activeProject()) => {
  if (!project.config.withheld.length) return text;
  let out = String(text ?? '');
  for (const tok of out.match(/[\w.~@%+-]*\/[\w./~@%+-]+/g) ?? []) if (hidePath(tok, project) !== tok) out = out.split(tok).join(hidePath(tok, project));
  return out;
};

export function withholdDiff(text, project = activeProject()) {
  if (!project.config.withheld.length) return text;
  return String(text ?? '')
    .split(/(?=^diff --git )/m)
    .map((chunk) => {
      if (!chunk.startsWith('diff --git ')) return chunk;
      const [f] = parseUnifiedDiff(chunk);
      if (!f || !(isWithheld(f.file, project) || isWithheld(f.oldFile, project))) return chunk;
      const name = hidePath(isWithheld(f.file, project) ? f.file : f.oldFile, project);
      return `diff --git a/${name} b/${name}\n[content withheld by config: ${f.added.length} line(s) added, ${f.removed.length} removed]\n`;
    })
    .join('');
}

// Comma-joined Read denies for --disallowedTools (unsafe globs are dropped).
// Config validation rejects any glob outside SAFE_GLOB, so none is dropped here
// silently; a stray one is a hard error (fail closed: no review).
export function withheldDenies(workspace, project = activeProject()) {
  const globs = project.config.withheld;
  if (globs.some((g) => !SAFE_GLOB(g))) throw new Error('withheld glob cannot be expressed as a Read deny');
  return globs.flatMap((g) => [`Read(/${workspace}/${g})`, `Read(/${workspace}/${g}.pr-head)`]).join(',');
}
