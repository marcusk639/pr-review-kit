// Advisory delivery for publish: security findings go to draft advisories
// with the advisory token only. Logs status codes only.
import { completedFindings } from './completion.mjs';
import { sanitizeLedger } from './ledger.mjs';
import { activeProject } from './config.mjs';

export const DELIVERED = 'details sent privately';
export const NOT_DELIVERED = 'details could not be delivered privately; re-run after fixing the advisory token';
export const NO_KEY = 'details could not be delivered privately; id key unavailable';
export const NO_CHANNEL = 'details withheld: no verified private channel';

// Security findings go to draft advisories first (advisoryToken only there,
// never to the comment calls), so the public pointer says whether that worked.
// Prior open security ids are looked up too, so a dispositioned advisory
// resolves its ledger entry (needs the key and the token, like delivery).
export async function deliver(repo, pr, snapshot, rest, deliverFn) {
  const findings = completedFindings(snapshot, rest.findingsText, rest.outcome, rest.narrative);
  if (!findings) return { clause: DELIVERED, resolvedIds: [] };
  // Advisories exist for public repos only; any other channel delivers nothing.
  if (activeProject().config.securityChannel !== 'advisory') return { clause: NO_CHANNEL, resolvedIds: [] };
  const security = findings.findings.filter((f) => f.security);
  const priorIds = rest.idKey ? sanitizeLedger(snapshot.ledger, rest.idKey).filter((e) => e.security && e.status === 'open').map((e) => e.id) : [];
  if (!security.length && !priorIds.length) return { clause: DELIVERED, resolvedIds: [] };
  try {
    const res = await deliverFn(repo, pr, security, rest.advisoryToken || null, undefined, rest.idKey || null, priorIds);
    const resolvedIds = Array.isArray(res?.resolvedIds) ? res.resolvedIds : [];
    return { clause: res?.delivered === true ? DELIVERED : NOT_DELIVERED, resolvedIds };
  } catch (err) {
    const code = Number.isInteger(err?.status) ? err.status : 'unknown';
    console.log(`advisories failed: ${code}`);
    return { clause: NOT_DELIVERED, resolvedIds: [] };
  }
}
