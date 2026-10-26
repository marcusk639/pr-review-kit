// git comes from the kit's check context (ctx.git: git -C <repo>, no token);
// checks never spawn processes themselves.
let gitFn = () => {
  throw new Error('ctx.git not set');
};
export const useGit = (fn) => {
  gitFn = fn;
};
export {
  checkQueriesVsIndexes,
  checkStoragePaths,
  checkCollectionsVsRules,
} from './contracts-firestore.mjs';

// homegroups <-> regroup functions duplicate pairs (symmetric).
const H = 'homegroups/functions/src/';
const R = 'regroup/functions/src/';
const same = (p) => [H + p, R + p];
export const TWIN_PAIRS = [
  same('api/api.ts'),
  same('api/recoveryApi.ts'),
  ...[
    'DirectoryMeeting',
    'RatsLocation',
    'LocationsApiResponse',
    'GeocodeResponse',
    'CelebrateRecoveryMeeting',
    'BaseEntity',
    'MeetingLocation',
    'AAMeetingResponse',
    'NAMeetingResponse',
  ].map((n) => same(`entities/${n}.ts`)),
  [H + 'utils/location.ts', R + 'util/location.ts'],
  [H + 'utils/date.ts', R + 'util/date.ts'],
  [H + 'utils/directoryMapping.ts', R + 'util/directoryMapping.ts'],
];

const CODE = /\.(?:ts|tsx|js|jsx|mjs)$/;
const FN_EXPORT = /export const (\w+) = (?:onCall|onRequest|onSchedule|functions\.)/;
const CLIENT_SPECS = [':(glob)*/mobile/src/**', ':(glob)*/web/src/**', 'homegroups/mobile/App.tsx'];

function clientHits(name, repoRoot) {
  try {
    return gitFn(['grep', '-l', '-w', '-F', '-e', name, '--', ...CLIENT_SPECS], repoRoot)
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // git grep: no match
    throw err;
  }
}

const list = (hits) => `${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ` (+${hits.length - 10} more)` : ''}`;

export function checkExports(files, repoRoot) {
  const facts = [];
  for (const f of files) {
    if (f.binary || !CODE.test(f.file)) continue;
    const addedNames = new Set();
    for (const a of f.added) {
      const m = FN_EXPORT.exec(a.text);
      if (!m) continue;
      addedNames.add(m[1]);
      const hits = clientHits(m[1], repoRoot);
      facts.push({
        check: 'exports',
        file: f.file,
        line: a.line,
        note: hits.length
          ? `'${m[1]}' referenced in: ${list(hits)}`
          : `'${m[1]}' not referenced in any mobile/web src or homegroups/mobile/App.tsx`,
      });
    }
    for (const r of f.removed ?? []) {
      const m = FN_EXPORT.exec(r.text);
      if (!m || addedNames.has(m[1])) continue;
      const hits = clientHits(m[1], repoRoot);
      facts.push({
        check: 'exports',
        file: f.file,
        line: r.line,
        note: hits.length
          ? `export removed: '${m[1]}' still referenced in: ${list(hits)}`
          : `export removed: no client references found for '${m[1]}'`,
      });
    }
  }
  return facts;
}

export function checkRegion(files) {
  const facts = [];
  for (const f of files) {
    if (f.binary || !CODE.test(f.file)) continue;
    for (const a of f.added) {
      if (/region\s*:|setGlobalOptions/.test(a.text)) {
        facts.push({
          check: 'region',
          file: f.file,
          line: a.line,
          note: 'region/global options changed; confirm callers use the same region',
        });
      }
    }
  }
  return facts;
}

export function checkTwins(files) {
  const facts = [];
  for (const f of files) {
    const seen = new Set();
    for (const path of new Set([f.file, f.oldFile])) {
      for (const [h, r] of TWIN_PAIRS) {
        const twin = path === h ? r : path === r ? h : null;
        if (!twin || seen.has(twin)) continue;
        seen.add(twin);
        facts.push({
          check: 'twins',
          file: f.file,
          note: `twin file ${twin} (homegroups/regroup duplicate); mirror the change or note the drift`,
        });
      }
    }
  }
  return facts;
}
