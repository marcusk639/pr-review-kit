// Model-free "neutralize PR head" step, run after the knowledge restore and
// before the model: removes every channel by which PR-head files could
// instruct or redirect the reviewer. Symlinks become placeholder files (a link
// could point at runner temp, the publish checkout, .git/config or /proc);
// CLAUDE.md, CLAUDE.local.md and AGENTS.md at any depth, nested .claude/ dirs,
// .ignore/.rgignore and .mcp.json/.claude.json are renamed *.pr-head; the root
// .claude/settings*.json are removed (claude-code-action restores .claude/
// from the base branch). Defence in depth: the model also runs with
// --setting-sources user and claudeMdExcludes. Logs counts only.
import { lstatSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.ignore', '.rgignore', '.gitignore', '.ripgreprc', '.mcp.json', '.claude.json']);
// .review-base is the trust checkout (cloned fresh by the action); anything
// else, .review-publish included, is PR content until replaced.
const DEFAULT_SKIP = ['.git', '.review-base'];
const PLACEHOLDER = 'pr-review: symlink removed from the PR head before review\n';

const moveAside = (p) => {
  rmSync(`${p}.pr-head`, { recursive: true, force: true });
  renameSync(p, `${p}.pr-head`);
};

export function neutralize(root, { skip = DEFAULT_SKIP } = {}) {
  const counts = { symlinks: 0, renamed: 0, removed: 0 };
  const top = resolve(root);
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = join(top, '.claude', f);
    try {
      if (lstatSync(p)) {
        rmSync(p, { force: true });
        counts.removed++;
      }
    } catch {
      // absent
    }
  }
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      if (depth === 0 && skip.includes(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        unlinkSync(p);
        writeFileSync(p, PLACEHOLDER);
        counts.symlinks++;
      } else if (st.isDirectory()) {
        if (name === '.claude' && depth > 0) {
          moveAside(p);
          counts.renamed++;
          walk(`${p}.pr-head`, depth + 1);
        } else walk(p, depth + 1);
      } else if (INSTRUCTION_FILES.has(name)) {
        moveAside(p);
        counts.renamed++;
      }
    }
  };
  walk(top, 0);
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = neutralize(process.argv[2] ?? '.', process.argv[3] ? { skip: [...DEFAULT_SKIP, ...process.argv[3].split(',')] } : undefined);
    console.log(`neutralize: ${r.symlinks} symlink(s) replaced, ${r.renamed} instruction file(s)/dir(s) set aside, ${r.removed} settings file(s) removed`);
  } catch (err) {
    // Fail the job: reviewing a tree that could not be neutralized is unsafe.
    console.log(`::error::pr-review neutralize failed (${err?.code ?? 'error'})`);
    process.exitCode = 1;
  }
}
