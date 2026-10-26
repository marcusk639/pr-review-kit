// A small declarative schema for config.json: each node validates its value,
// fills defaults and reports errors by dotted path. Never throws on bad input.
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const leaf = (test, what) => ({ kind: 'leaf', test, what });
export const str = leaf((v) => typeof v === 'string' && v.trim() !== '', 'a non-empty string');
export const bool = leaf((v) => typeof v === 'boolean', 'true or false');
export const int = (min, max) => leaf((v) => Number.isInteger(v) && v >= min && v <= max, `an integer ${min}-${max}`);
export const num = (min, max) => leaf((v) => typeof v === 'number' && v >= min && v <= max, `a number ${min}-${max}`);
export const oneOf = (...xs) => leaf((v) => xs.includes(v), `one of ${xs.join(', ')}`);
const regexOk = (v) => {
  try {
    new RegExp(v);
    return typeof v === 'string';
  } catch {
    return false;
  }
};
export const regex = leaf(regexOk, 'a valid regular expression');
export const list = (item) => ({ kind: 'list', item });
export const obj = (fields) => ({ kind: 'obj', fields });
export const orFalse = (inner) => ({ kind: 'orFalse', inner });
export const map = (item, keys = null) => ({ kind: 'map', item, keys });
export const custom = (fn) => ({ kind: 'custom', fn });

// Returns the merged value (default where the input is missing or invalid).
export function apply(node, value, dflt, path, errors) {
  if (value === undefined) return structuredClone(dflt);
  switch (node.kind) {
    case 'leaf':
      if (node.test(value)) return value;
      errors.push(`${path} must be ${node.what}`);
      return structuredClone(dflt);
    case 'list':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be a list`);
        return structuredClone(dflt);
      }
      return value.map((v, i) => apply(node.item, v, undefined, `${path}[${i}]`, errors)).filter((v) => v !== undefined);
    case 'orFalse':
      if (value === false) return false;
      return apply(node.inner, value, isObj(dflt) ? dflt : {}, path, errors);
    case 'map': {
      if (!isObj(value)) {
        errors.push(`${path} must be an object`);
        return structuredClone(dflt);
      }
      const out = { ...(dflt ?? {}) };
      for (const [k, v] of Object.entries(value)) {
        if (node.keys && !node.keys.includes(k)) errors.push(`unknown key: ${path}.${k}`);
        else out[k] = apply(node.item, v, dflt?.[k], `${path}.${k}`, errors);
      }
      return out;
    }
    case 'obj': {
      if (!isObj(value)) {
        errors.push(`${path} must be an object`);
        return structuredClone(dflt);
      }
      const out = {};
      for (const k of Object.keys(value)) if (!(k in node.fields)) errors.push(`unknown key: ${path ? `${path}.` : ''}${k}`);
      for (const [k, sub] of Object.entries(node.fields)) out[k] = apply(sub, value[k], dflt?.[k], path ? `${path}.${k}` : k, errors);
      return out;
    }
    case 'custom':
      return node.fn(value, dflt, path, errors);
    default:
      return dflt;
  }
}
