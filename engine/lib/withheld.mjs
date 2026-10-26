// config.withheld: paths the model must never read (private notes, client
// material). The model gets Read denies for them and a diff whose hunks for
// them are replaced by a one-line stub; facts' checks and the secret scan
// still see the full diff; publish never posts an inline comment on them.
import { activeProject } from './config.mjs';
import { matches } from './glob.mjs';
import { parseUnifiedDiff } from './diff.mjs';

const SAFE_GLOB = /^[A-Za-z0-9_.*?\/-]+$/;

export const isWithheld = (path, project = activeProject()) => project.config.withheld.some((g) => matches(String(path ?? ''), g));

export function withholdDiff(text, project = activeProject()) {
  if (!project.config.withheld.length) return text;
  return String(text ?? '')
    .split(/(?=^diff --git )/m)
    .map((chunk) => {
      if (!chunk.startsWith('diff --git ')) return chunk;
      const [f] = parseUnifiedDiff(chunk);
      if (!f || !(isWithheld(f.file, project) || isWithheld(f.oldFile, project))) return chunk;
      const header = chunk.split('\n')[0];
      return `${header}\n[content withheld by config: ${f.added.length} line(s) added, ${f.removed.length} removed]\n`;
    })
    .join('');
}

// Comma-joined Read denies for --disallowedTools (unsafe globs are dropped).
export function withheldDenies(workspace, project = activeProject()) {
  return project.config.withheld.filter((g) => SAFE_GLOB.test(g)).map((g) => `Read(/${workspace}/${g})`).join(',');
}
