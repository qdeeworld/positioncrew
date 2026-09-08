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

export function currentHireErrorMessage(message: string): string {
  return isCurrentHireRefreshError(message)
    ? "The saved request is no longer current. Refresh the position or market above before starting a new comparison or hire. Your recorded job is retained."
    : message;
}
