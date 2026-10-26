// Secret scrubbing for any text that may be posted publicly. No I/O: the
// project's extra patterns come from the already-loaded config.
import { activeProject } from './config.mjs';

// Patterns are assembled from parts so this source holds no secret-shaped literal
// (the repo pre-commit secret scan would otherwise flag it).
const P = (...parts) => new RegExp(parts.join(''));
// Left boundary: a prefix glued to a letter/digit (task_test_x, capture_foo) is not a secret; '_' before it is allowed (KEY_sk_live_...).
const B = '(?<![A-Za-z0-9])';

export const SECRET_PATTERNS = [
  P(B, 'whsec', '_', '[A-Za-z0-9]{8,}'),
  P(B, 'sk', '_live_', '[A-Za-z0-9]{8,}'),
  P(B, 'sk', '_test_', '[A-Za-z0-9]{8,}'),
  P(B, 'rk', '_live_', '[A-Za-z0-9]{8,}'),
  P(B, 'sk', '-ant-', '[A-Za-z0-9_-]{8,}'),
  P(B, 'sk', '-or-v1-', '[A-Za-z0-9]{8,}'),
  P(B, 'AKIA', '[0-9A-Z]{16}'),
  P(B, 'gh[posur]', '_', '[A-Za-z0-9]{20,}'),
  P(B, 'github', '_pat_', '[A-Za-z0-9_]{22,}'),
  P(B, 'SG', '\\.', '[\\w-]{20,}', '\\.', '[\\w-]{20,}'),
  P(B, 're', '_', '(?=[A-Za-z0-9]*\\d)', '[A-Za-z0-9]{20,}'),
  P(B, 'AIza', '[0-9A-Za-z_-]{35}'),
  P('-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)'),
];

let cached = { key: null, list: SECRET_PATTERNS };

// The kit's patterns plus config.secrets.extraPatterns (validated as regexes when loaded).
export function secretPatterns(config = activeProject().config) {
  const extra = config?.secrets?.extraPatterns ?? [];
  const key = JSON.stringify(extra);
  if (cached.key !== key) {
    const own = extra.flatMap((src) => {
      try {
        return [new RegExp(src)];
      } catch {
        return [];
      }
    });
    cached = { key, list: [...SECRET_PATTERNS, ...own] };
  }
  return cached.list;
}

export function redact(text) {
  let out = String(text ?? '');
  for (const re of secretPatterns()) out = out.replace(new RegExp(re.source, 'g'), (m) => m.slice(0, 6) + '…');
  return out;
}
