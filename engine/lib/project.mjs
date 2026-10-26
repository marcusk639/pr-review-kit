// The project as facts and publish both use it: config and routing plus the
// classes learned precision has demoted, all from the same base checkout.
import { loadProject } from './config.mjs';
import { demotedClasses, readPrecision } from '../learn/precision.mjs';

export function loadReviewProject(dir) {
  const project = loadProject(dir);
  project.demotedClasses = project.errors.length ? new Set() : demotedClasses(readPrecision(dir), project.config);
  return project;
}
