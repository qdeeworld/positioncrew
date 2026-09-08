import { AlertTriangle } from "lucide-react";
import { selectedProviderFailureMessage, type SelectedProviderExecution } from "../provider-presentation";

export function ProviderFailureSummary({
  execution,
  limitations,
}: {
  execution: SelectedProviderExecution | null | undefined;
  limitations: readonly string[];
}) {
  const message = selectedProviderFailureMessage(execution, limitations);
  if (message === null) return null;

  return (
    <section aria-label="Selected provider failure">
      <h3>Why this hire was refused</h3>
      <ul className="guard-list">
        <li><AlertTriangle size={14} aria-hidden="true" /><span>{message}</span></li>
        <li><AlertTriangle size={14} aria-hidden="true" /><span>No fallback provider was used. No payment or liquidity transaction occurred.</span></li>
      </ul>
    </section>
  );
}
