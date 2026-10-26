// Example project check: a route string added in src/ that no client mentions.
// Runs in the facts step from the base checkout; returns hints, never verdicts.
const ROUTE = /'(\/api\/[\w/-]+)'/g;

export default [
  {
    name: 'route-clients',
    run({ files, git }) {
      const facts = [];
      for (const f of files.filter((x) => x.file.startsWith('src/') && !x.binary)) {
        for (const a of f.added) {
          for (const m of a.text.matchAll(ROUTE)) {
            let hits = '';
            try {
              hits = git(['grep', '-l', '-F', '-e', m[1], '--', 'web']).trim();
            } catch {
              hits = '';
            }
            facts.push({ file: f.file, line: a.line, note: hits ? `route ${m[1]} used in: ${hits.split('\n').join(', ')}` : `route ${m[1]} not referenced under web/` });
          }
        }
      }
      return facts;
    },
  },
];
