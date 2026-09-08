export interface SelectedProviderExecution {
  outcome: string;
  invocation?: {
    checks?: readonly { code: string; status: string; detail?: string }[];
  } | null;
}

const changedTermsMessage = "The selected provider changed its assessment after you chose it. Refresh the comparison and choose a provider again.";

function timeoutMessage(detail: string): string {
  const milliseconds = /\b(\d{1,6})\s*ms\s+deadline\b/i.exec(detail)?.[1];
  const duration = milliseconds === undefined ? null : Number(milliseconds);
  const elapsed = duration !== null && duration > 0 && duration <= 120_000
    ? ` after ${duration / 1_000} seconds`
    : "";
  const operation = /\bgetCurrentPoolPrice\b/.test(detail) ? "pool-price check" : "response";
  return `Waiting for the selected provider's ${operation} timed out${elapsed}. Refresh the comparison and try again.`;
}

function deliveryDeadlineMessage(detail: string): string {
  const milliseconds = /^PositionCrew's LP delivery deadline expired after ([1-9]\d{0,4}) ms; the external invocation did not complete\.$/.exec(detail)?.[1];
  const budget = milliseconds === undefined ? null : Number(milliseconds);
  const elapsed = budget !== null && budget <= 20_000
    ? ` after ${budget / 1_000} seconds`
    : "";
  return `The job's bounded delivery wait timed out${elapsed}. This wait is limited by the delivery time budget and the remaining lifetime of your request and saved market data. Refresh the comparison and try again.`;
}

export function selectedProviderFailureMessage(
  execution: SelectedProviderExecution | null | undefined,
  limitations: readonly string[] = [],
): string | null {
  if (execution?.outcome !== "REFUSED") return null;

  const failedCheck = execution.invocation?.checks?.find((check) => check.status === "FAIL");
  const detail = failedCheck?.detail ?? limitations.find((limitation) =>
    limitation.includes("[HEYANON_MCP_LOCAL_TIMEOUT]") ||
    limitation === "The external provider response changed after the buyer selected it.",
  ) ?? "";
  const code = failedCheck?.code ?? (/\[([A-Z_]+)\]/.exec(detail)?.[1] ?? "");

  if (code === "LP_DELIVERY_DEADLINE") return deliveryDeadlineMessage(detail);
  if (code === "HEYANON_MCP_LOCAL_TIMEOUT") return timeoutMessage(detail);
  if (code === "AUDITION_RESULT_STABLE" ||
      (!failedCheck && detail === "The external provider response changed after the buyer selected it.")) {
    return changedTermsMessage;
  }
  if (code === "RANGE_WIDTH_POLICY") {
    return "The selected provider's proposed range does not fit your width limits. Refresh the comparison before choosing a provider again.";
  }
  if (code === "CURRENT_PRICE_COHERENCE") {
    return "The selected provider's price does not agree closely enough with this job's saved market data. Refresh the comparison before choosing a provider again.";
  }
  if (code === "NORMALIZED_EVIDENCE_GATE") {
    return "The selected provider's result did not pass this job's data and expiry checks. Refresh the current position and compare providers again.";
  }

  // Provider diagnostics can contain URLs or upstream response text. Keep those
  // in the receipt rather than copying arbitrary details into the primary UI.
  return "The selected provider could not pass the required job checks. Open the receipt for the recorded failure, then refresh the comparison before trying again.";
}

export function identityNetworkLabel(explorerUrl: string): string {
  try {
    const url = new URL(explorerUrl);
    if (url.protocol === "https:" && url.hostname === "testnet.bscscan.com") return "BSC testnet";
    if (url.protocol === "https:" && url.hostname === "bscscan.com") return "BSC mainnet";
  } catch {
    // A malformed evidence link must not be promoted to a verified network.
  }
  return "Network not established";
}
