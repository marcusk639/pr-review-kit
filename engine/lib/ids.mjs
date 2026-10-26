// Opaque ledger ids: HMAC with PR_REVIEW_ID_KEY when there is one (see ledger.mjs).
import { createHash, createHmac } from 'node:crypto';

export const ID_RE = /^[0-9a-f]{16}$/;

export function opaqueId(slug, key) {
  const h = key ? createHmac('sha256', String(key)) : createHash('sha256');
  return h.update(String(slug), 'utf8').digest('hex').slice(0, 16);
}
