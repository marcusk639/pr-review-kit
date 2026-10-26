// Side-effect import for ported tests: the recovery-platform reference
// project (its routing and classes) as the active project.
import { fileURLToPath } from 'node:url';
import { loadProject, setActiveProject } from '../../lib/config.mjs';

export const RP_DIR = fileURLToPath(new URL('../fixtures/rp/', import.meta.url));
export const RP = loadProject(RP_DIR);
setActiveProject(RP);
