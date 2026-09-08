import { canonicalJson } from "../../src/commerce/fresh-hire-schema.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// This is a UI guard, not authentication. The server still verifies the binding
// and enforces the financial and freshness limits at execution time.
export function currentRequestNeedsRefresh(request: unknown, observation: unknown, now = Date.now()): boolean {
  const input = record(request);
  const source = record(observation);
  const binding = record(source?.binding);
  if (!input || !source || !binding || !Number.isFinite(now)) return true;
  const { maxDataAgeSeconds } = input;
  if (typeof maxDataAgeSeconds !== "number" || !Number.isFinite(maxDataAgeSeconds) || maxDataAgeSeconds < 0) return true;
  const timestamps = [input.deadline, source.observedAt, binding.expiresAt];
  if (timestamps.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)))) return true;
  const deadline = Date.parse(input.deadline as string);
  const observedAt = Date.parse(source.observedAt as string);
  const bindingExpiry = Date.parse(binding.expiresAt as string);
  const freshnessExpiry = observedAt + maxDataAgeSeconds * 1_000;
  if (!Number.isFinite(freshnessExpiry)) return true;
  return now >= Math.min(deadline, freshnessExpiry, bindingExpiry);
}

export function isCurrentHireRefreshError(message: string | null): boolean {
  return message !== null && /\bREFRESH_REQUIRED\b/.test(message);
}

// The binding contains the signed request commitment. Comparing its contents
// keeps a rejected probe rejected when the UI reconstructs its wrapper object.
export function currentRequestEvidenceKey(observation: unknown): string | null {
  const source = record(observation);
  const binding = record(source?.binding);
  if (!source || !binding) return null;
  return canonicalJson({
    blockNumber: source.blockNumber,
    observedAt: source.observedAt,
    explorerUrl: source.explorerUrl,
    binding,
  });
}

export function persistedCurrentHireFailureMessage(error: unknown): string {
  const failure = record(error);
  if (failure?.code === "REFRESH_REQUIRED") return "REFRESH_REQUIRED";
  return typeof failure?.message === "string" ? failure.message : "Persisted provider job failed";
}

export function currentHireErrorMessage(message: string): string {
  return isCurrentHireRefreshError(message)
    ? "The saved request is no longer current. Refresh the position or market above before starting a new comparison or hire. Your recorded job is retained."
    : message;
}
