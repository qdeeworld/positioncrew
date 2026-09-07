import type { FreshMarketplaceChain } from "./types.js";

// Expiry prevents starting a saved current job, not reading its receipt or
// recovering a job that the server has already started.
export function currentHireExpired(
  chain: Pick<FreshMarketplaceChain, "hire" | "job"> | null,
  now = Date.now(),
): boolean {
  if (!chain || chain.job.state !== "CREATED" || chain.hire.evidenceMode !== "CURRENT_BLOCK_PINNED") return false;
  const evidence = chain.hire.evidence;
  if (evidence?.evidenceClass !== "CURRENT_BLOCK_PINNED") return true;
  const deadline = typeof chain.hire.request.deadline === "string" ? Date.parse(chain.hire.request.deadline) : NaN;
  const age = chain.hire.request.maxDataAgeSeconds;
  const observedAt = Date.parse(evidence.source.observedAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(observedAt) ||
    typeof age !== "number" || !Number.isFinite(age) || age <= 0 || !Number.isFinite(now)) return true;
  const authenticatedExpiry = evidence.observationBinding?.expiresAt;
  const bindingExpiry = authenticatedExpiry === undefined ? Infinity : Date.parse(authenticatedExpiry);
  if (Number.isNaN(bindingExpiry)) return true;
  return now >= Math.min(deadline, observedAt + age * 1_000, bindingExpiry);
}
