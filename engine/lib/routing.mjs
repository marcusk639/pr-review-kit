import { matches } from './glob.mjs';
import { activeProject, alwaysClasses } from './config.mjs';

// Longest prefix first so e.g. regroup/functions wins over a bare product dir.
const byLength = (packages) => [...packages].sort((a, b) => b.length - a.length);

export function packageOf(file, project = activeProject()) {
  return byLength(project.config.packages).find((p) => file === p || file.startsWith(`${p}/`)) ?? 'repo';
}

export function route(files, project = activeProject()) {
  const packages = new Set();
  const linkTypes = new Set();
  const classes = new Set(alwaysClasses(project.config));
  for (const file of files) {
    packages.add(packageOf(file, project));
    for (const entry of project.routing) {
      if (entry.paths.some((p) => matches(file, p))) {
        linkTypes.add(entry.linkType);
        for (const c of entry.classes) classes.add(c);
      }
    }
  }
  return {
    packages: [...packages].sort(),
    linkTypes: [...linkTypes],
    classes: [...classes].sort((a, b) => a - b),
  };
}
